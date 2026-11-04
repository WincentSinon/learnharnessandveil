import type { ReaderSpeechBridge, ReaderSpeechState, ReaderSpeechVoice } from "@/src/core";

export interface NarrationState {
	status: "idle" | "loading" | "speaking" | "paused" | "error";
	page: number;
	voices: ReaderSpeechVoice[];
	voice: string;
	rate: number;
	available: boolean;
	message: string;
}

export const EMPTY_NARRATION: NarrationState = {
	status: "idle", page: 1, voices: [], voice: "", rate: 0, available: false,
	message: "Read aloud is available in the Windows desktop app.",
};

/** PDF text runs retain their line breaks; marked-content records are not speech. */
export function pageSpeechText(items: readonly unknown[]): string {
	let text = "";
	for (const item of items) {
		if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") continue;
		const value = item.str.replace(/[\u0000\u00ad]/g, "");
		if (text && !/\s$/.test(text) && value && !/^\s/.test(value)) text += " ";
		text += value;
		if ("hasEOL" in item && item.hasEOL) text += "\n";
	}
	return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "Speech could not be completed.";
}

/** Owns following and cancellation independently of PDF canvas rendering and React updates. */
export class ReaderNarration {
	private state: NarrationState = { ...EMPTY_NARRATION };
	private revision = 0;
	private requestId: string | null = null;
	private following = false;
	private paused = false;
	private nativePaused = false;
	private disposed = false;
	private off: () => void;

	constructor(
		private bridge: ReaderSpeechBridge,
		private textForPage: (page: number) => Promise<string | null>,
		private changed: (state: NarrationState) => void,
		private newId: () => string = () => crypto.randomUUID(),
	) {
		this.off = bridge.onState(state => this.nativeState(state));
	}

	private update(patch: Partial<NarrationState>) {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		this.changed(this.state);
	}

	async initialize() {
		try {
			const voices = await this.bridge.voices();
			if (this.disposed) return;
			this.update({ voices, voice: voices[0]?.name ?? "", available: voices.length > 0,
				message: voices.length ? "Reads this page. Follows you when you change pages." : "No Windows speech voices are installed." });
		} catch (error) { this.update({ status: "error", message: errorMessage(error) }); }
	}

	private nativeState(state: ReaderSpeechState) {
		if (this.disposed || !this.requestId || state.requestId !== this.requestId) return;
		if (state.status === "idle") {
			this.revision++;
			this.requestId = null;
			this.following = this.paused = this.nativePaused = false;
			this.update({ status: "idle", message: `Finished page ${this.state.page}. Choose Read aloud to start again.` });
		} else if (state.status === "error") this.fail(state.error || "Speech could not be completed.");
		else if (!this.paused) this.update({ status: state.status, message: `Reading page ${this.state.page} · follows your page` });
	}

	private invalidate() {
		this.requestId = null;
		return ++this.revision;
	}

	private fail(message: string) {
		this.invalidate();
		this.following = this.paused = this.nativePaused = false;
		this.update({ status: "error", message });
	}

	private async begin() {
		const revision = this.invalidate();
		const page = this.state.page;
		this.following = true;
		this.paused = this.nativePaused = false;
		this.update({ status: "loading", message: `Preparing page ${page}…` });
		try {
			await this.bridge.stop();
			if (this.disposed || revision !== this.revision) return;
			const text = await this.textForPage(page);
			if (this.disposed || revision !== this.revision) return;
			if (text === null) { this.stop(); return; }
			if (!text.trim()) { this.fail(`Page ${page} has no readable text. Scanned pages need OCR before they can be read aloud.`); return; }
			this.requestId = this.newId();
			const state = await this.bridge.speak({ text, voice: this.state.voice, rate: this.state.rate, requestId: this.requestId });
			if (this.disposed || revision !== this.revision) return;
			this.nativeState(state);
		} catch (error) { if (!this.disposed && revision === this.revision) this.fail(errorMessage(error)); }
	}

	read() {
		if (!this.state.available || this.disposed) return;
		void this.begin();
	}

	setPage(page: number) {
		if (page === this.state.page || this.disposed) return;
		this.update({ page });
		if (!this.following) return;
		if (this.paused) this.deferToCurrentPage();
		else void this.begin();
	}

	private deferToCurrentPage() {
		const revision = this.invalidate();
		this.nativePaused = false;
		this.update({ status: "paused", message: `Paused · Resume will read page ${this.state.page}` });
		void this.bridge.stop().catch(error => { if (revision === this.revision) this.fail(errorMessage(error)); });
	}

	pause() {
		if (!this.following || this.paused || this.disposed) return;
		this.paused = true;
		if (this.state.status === "loading") { this.deferToCurrentPage(); return; }
		this.nativePaused = true;
		const revision = this.revision;
		this.update({ status: "paused", message: `Paused on page ${this.state.page}` });
		void this.bridge.pause().then(state => {
			if (revision !== this.revision || this.disposed) return;
			if (state.status === "error") this.fail(state.error || "Speech could not be paused.");
			else if (state.status === "idle") this.nativeState(state);
		}).catch(error => { if (revision === this.revision) this.fail(errorMessage(error)); });
	}

	resume() {
		if (!this.following || !this.paused || this.disposed) return;
		if (!this.nativePaused) { void this.begin(); return; }
		this.paused = this.nativePaused = false;
		const revision = this.revision;
		this.update({ status: "speaking", message: `Reading page ${this.state.page} · follows your page` });
		void this.bridge.resume().then(state => {
			if (revision === this.revision && !this.disposed) this.nativeState(state);
		}).catch(error => { if (revision === this.revision) this.fail(errorMessage(error)); });
	}

	stop() {
		if (this.disposed) return;
		const revision = this.invalidate();
		this.following = this.paused = this.nativePaused = false;
		this.update({ status: "idle", message: "Stopped. Choose Read aloud to read the current page." });
		void this.bridge.stop().catch(error => { if (revision === this.revision) this.fail(errorMessage(error)); });
	}

	setVoice(voice: string) {
		if (!this.state.voices.some(value => value.name === voice)) return;
		this.update({ voice });
		this.settingsChanged();
	}

	setRate(rate: number) {
		if (![-2, 0, 2, 4].includes(rate)) return;
		this.update({ rate });
		this.settingsChanged();
	}

	private settingsChanged() {
		if (!this.following) return;
		if (this.paused) this.deferToCurrentPage();
		else void this.begin();
	}

	dispose() {
		this.invalidate();
		this.disposed = true;
		this.off();
		void this.bridge.stop().catch(() => {});
	}
}
