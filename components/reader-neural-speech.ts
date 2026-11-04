import type { ReaderSpeechBridge, ReaderSpeechInput, ReaderSpeechProgress, ReaderSpeechState } from "@/src/core";
export interface NeuralStatus { ready: boolean; installing: boolean; message: string; voices: Array<{ name: string; language: string }>; downloadBytes: number }
export async function neuralSpeechStatus(): Promise<NeuralStatus> { return (await fetch("/api/reader/speech")).json(); }
export async function setupNeuralSpeech() { const response = await fetch("/api/reader/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "install" }) }); if (!response.ok) throw new Error("Voice setup could not start."); }
export function speechChunks(text: string, language: string) {
	const chunks: Array<{ text: string; start: number; end: number }> = [];
	for (const segment of new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)) {
		let offset = segment.index;
		let rest = segment.segment;
		while (rest.length) {
			let length = Math.min(rest.length, 500);
			if (length < rest.length) { const space = rest.lastIndexOf(" ", length); if (space > 200) length = space + 1; }
			if (length < rest.length && /[\uD800-\uDBFF]/.test(rest[length - 1]!) && /[\uDC00-\uDFFF]/.test(rest[length]!)) length--;
			const raw = rest.slice(0, length), trimmed = raw.trim();
			if (trimmed) { const start = offset + raw.indexOf(trimmed); chunks.push({ text: trimmed, start, end: start + trimmed.length }); }
			offset += length; rest = rest.slice(length);
		}
	}
	return chunks;
}

/** Actual audio playback owns pause/completion; text never leaves the loopback API. */
export function createNeuralSpeechBridge(fallback?: ReaderSpeechBridge): ReaderSpeechBridge {
	let snapshot: ReaderSpeechState = { status: "idle", requestId: null };
	let generation = 0, audio: HTMLAudioElement | null = null, objectUrl: string | null = null;
	let abort: AbortController | null = null, paused = false, native = false;
	let releasePause: (() => void) | null = null, finishAudio: (() => void) | null = null;
	const listeners = new Set<(state: ReaderSpeechState) => void>();
	const progress = new Set<(value: ReaderSpeechProgress) => void>();
	const publish = (value: ReaderSpeechState) => { snapshot = value; for (const cb of listeners) cb({ ...value }); };
	const offFallback = fallback?.onState(value => { if (native) publish(value); });
	function clearAudio() {
		if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); audio = null; }
		if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
		finishAudio?.(); finishAudio = null; releasePause?.(); releasePause = null;
	}
	async function stop() { generation++; abort?.abort(); abort = null; paused = false; clearAudio(); if (native) await fallback?.stop(); native = false; publish({ status: "idle", requestId: snapshot.requestId }); return { ...snapshot }; }
	return {
		async voices() { const status = await neuralSpeechStatus().catch(() => ({ voices: [] })); const others = await fallback?.voices().catch(() => []) ?? []; return [...(Array.isArray(status.voices) ? status.voices : []), ...others]; },
		state: async () => ({ ...snapshot }), stop,
		onState(cb) { listeners.add(cb); return () => { listeners.delete(cb); if (!listeners.size) offFallback?.(); }; },
		onProgress(cb) { progress.add(cb); return () => { progress.delete(cb); }; },
		async speak(input: ReaderSpeechInput) {
			const stopping = stop(); const owner = generation; await stopping;
			if (owner !== generation) return { status: "idle", requestId: input.requestId };
			if (!input.voice.endsWith("(neural)")) { if (!fallback) throw new Error("Choose a local neural voice."); native = true; return fallback.speak(input); }
			abort = new AbortController(); const signal = abort.signal;
			const chunks = speechChunks(input.text, input.voice.startsWith("Svenska") ? "sv" : "en");
			if (!chunks.length) throw new Error("This page has no readable text.");
			let accepted = false;
			let accept!: (state: ReaderSpeechState) => void;
			const acceptance = new Promise<ReaderSpeechState>(resolve => { accept = resolve; });
			const fetchChunk = async (chunk: typeof chunks[number]) => {
				const response = await fetch("/api/reader/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: chunk.text, voice: input.voice, rate: input.rate }), signal });
				if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Local speech could not be generated.");
				return response.blob();
			};
			void (async () => {
				try {
					let pending = fetchChunk(chunks[0]!);
					for (let index = 0; index < chunks.length; index++) {
						const blob = await pending;
						if (owner !== generation || signal.aborted) return;
						const next = chunks[index + 1];
						if (next) { pending = fetchChunk(next); void pending.catch(() => {}); }
						if (paused) await new Promise<void>(resolve => { releasePause = resolve; });
						if (owner !== generation || signal.aborted) return;
						objectUrl = URL.createObjectURL(blob); audio = new Audio(objectUrl);
						const currentAudio = audio;
						const ended = new Promise<void>((resolve, reject) => { finishAudio = resolve; currentAudio.onended = () => resolve(); currentAudio.onerror = () => reject(new Error("Audio playback failed.")); });
						void ended.catch(() => {});
						await audio.play();
						if (owner !== generation || signal.aborted) return;
						publish({ status: "speaking", requestId: input.requestId });
						for (const cb of progress) cb({ requestId: input.requestId, start: chunks[index]!.start, end: chunks[index]!.end, unit: "sentence" });
						if (!accepted) { accepted = true; accept({ ...snapshot }); }
						await ended;
						if (owner !== generation || signal.aborted) return;
						clearAudio();
					}
					if (owner === generation) publish({ status: "idle", requestId: input.requestId });
				} catch (error) { if (owner === generation && !signal.aborted) { clearAudio(); publish({ status: "error", requestId: input.requestId, error: error instanceof Error ? error.message : "Local speech failed." }); } }
				finally { if (!accepted) accept(owner === generation ? { ...snapshot } : { status: "idle", requestId: input.requestId }); }
			})();
			return acceptance;
		},
		async pause() { if (native) return fallback!.pause(); paused = true; audio?.pause(); publish({ ...snapshot, status: "paused" }); return { ...snapshot }; },
		async resume() { if (native) return fallback!.resume(); paused = false; releasePause?.(); releasePause = null; if (audio) await audio.play(); publish({ ...snapshot, status: "speaking" }); return { ...snapshot }; },
	};
}
