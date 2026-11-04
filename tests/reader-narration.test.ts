import assert from "node:assert/strict";
import test from "node:test";
import type { ReaderSpeechBridge, ReaderSpeechInput, ReaderSpeechState } from "../src/core/reader-speech.ts";
import { EMPTY_NARRATION, ReaderNarration, pageSpeechText, type NarrationState } from "../components/reader-narration.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(text: (page: number) => Promise<string | null> = async page => `Text on page ${page}.`) {
	let state: ReaderSpeechState = { status: "idle", requestId: null };
	let listener: ((state: ReaderSpeechState) => void) | null = null;
	const speaks: ReaderSpeechInput[] = [];
	const calls: string[] = [];
	let snapshot: NarrationState = { ...EMPTY_NARRATION };
	let id = 0;
	const bridge: ReaderSpeechBridge = {
		voices: async () => [{ name: "English", language: "en-US" }, { name: "Swedish", language: "sv-SE" }],
		state: async () => state,
		speak: async input => { calls.push("speak"); speaks.push(input); return state = { status: "speaking", requestId: input.requestId }; },
		stop: async () => { calls.push("stop"); return state = { status: "idle", requestId: state.requestId }; },
		pause: async () => { calls.push("pause"); return state = { ...state, status: "paused" }; },
		resume: async () => { calls.push("resume"); return state = { ...state, status: "speaking" }; },
		onState: callback => { listener = callback; return () => { listener = null; }; },
	};
	const reader = new ReaderNarration(bridge, text, value => { snapshot = value; }, () => `request_${++id}`);
	return { reader, speaks, calls, snapshot: () => snapshot, emit: (value: ReaderSpeechState) => listener?.(value) };
}

test("page speech preserves words and Unicode while joining wrapped lines and skipping PDF metadata", () => {
	assert.equal(pageSpeechText([
		{ type: "beginMarkedContent", id: "Ignore this" }, { str: "UNIX" }, { str: " services", hasEOL: true },
		{ str: "Svenska\u00ad ord\u0000" }, { str: "på svenska.", hasEOL: true }, { str: "" },
	]), "UNIX services Svenska ord på svenska.");
	assert.equal(pageSpeechText([{ type: "beginMarkedContent" }]), "");
});

test("read starts at the current page, follows navigation and disarms at page end", async () => {
	const t = setup(); await t.reader.initialize();
	t.reader.setPage(2); t.reader.read(); await tick();
	assert.equal(t.speaks[0]?.text, "Text on page 2.");
	t.reader.setPage(3); await tick();
	assert.equal(t.speaks[1]?.text, "Text on page 3.");
	assert.equal(t.calls.filter(call => call === "stop").length, 2);
	t.emit({ status: "idle", requestId: t.speaks[1]!.requestId });
	assert.equal(t.snapshot().status, "idle");
	assert.match(t.snapshot().message, /Finished page 3/);
	t.reader.setPage(4); await tick();
	assert.equal(t.speaks.length, 2);
	t.reader.dispose();
});

test("same-page Pause and Resume preserve the native speech position", async () => {
	const t = setup(); await t.reader.initialize(); t.reader.read(); await tick();
	t.reader.pause(); await tick();
	assert.equal(t.snapshot().status, "paused");
	t.reader.resume(); await tick();
	assert.equal(t.snapshot().status, "speaking");
	assert.equal(t.speaks.length, 1);
	assert.deepEqual(t.calls, ["stop", "speak", "pause", "resume"]);
	t.reader.dispose();
});

test("page changes while paused remain silent; Resume starts the new page", async () => {
	const t = setup(); await t.reader.initialize(); t.reader.read(); await tick();
	t.reader.pause(); await tick(); t.reader.setPage(2); await tick();
	assert.equal(t.snapshot().status, "paused"); assert.equal(t.speaks.length, 1);
	assert.match(t.snapshot().message, /Resume will read page 2/);
	t.reader.resume(); await tick();
	assert.equal(t.speaks[1]?.text, "Text on page 2.");
	assert.equal(t.calls.includes("resume"), false);
	t.reader.dispose();
});

test("voice and speed changes restart playing speech but never unpause it", async () => {
	const t = setup(); await t.reader.initialize(); t.reader.read(); await tick();
	t.reader.setVoice("Swedish"); await tick();
	assert.equal(t.speaks[1]?.voice, "Swedish");
	t.reader.pause(); await tick(); t.reader.setRate(2); await tick();
	assert.equal(t.snapshot().status, "paused"); assert.equal(t.speaks.length, 2);
	t.reader.resume(); await tick();
	assert.equal(t.speaks[2]?.rate, 2); assert.equal(t.speaks[2]?.voice, "Swedish");
	t.reader.dispose();
});

test("a late extraction or completion cannot speak or stop a superseded page", async () => {
	let release: (value: string) => void = () => {};
	const first = new Promise<string>(resolve => { release = resolve; });
	const t = setup(page => page === 1 ? first : Promise.resolve(`Page ${page}`));
	await t.reader.initialize(); t.reader.read(); await tick();
	t.reader.setPage(2); await tick();
	release("Stale page one"); await tick();
	assert.equal(t.speaks.length, 1); assert.equal(t.speaks[0]?.text, "Page 2");
	const old = t.speaks[0]!.requestId;
	t.reader.setPage(3); await tick();
	t.emit({ status: "idle", requestId: old });
	assert.equal(t.snapshot().status, "speaking"); assert.equal(t.snapshot().page, 3);
	t.reader.dispose();
});

test("Pause during extraction stays silent until Resume; Stop cancels the pending read", async () => {
	let release: (value: string) => void = () => {};
	let first = true;
	const pending = new Promise<string>(resolve => { release = resolve; });
	const t = setup(() => { if (first) { first = false; return pending; } return Promise.resolve("Fresh text"); });
	await t.reader.initialize(); t.reader.read(); await tick(); t.reader.pause();
	release("Old text"); await tick();
	assert.equal(t.snapshot().status, "paused"); assert.equal(t.speaks.length, 0);
	t.reader.resume(); await tick();
	assert.equal(t.speaks[0]?.text, "Fresh text");
	t.reader.stop(); t.reader.setPage(2); await tick();
	assert.equal(t.snapshot().status, "idle"); assert.equal(t.speaks.length, 1);
	t.reader.dispose();
});

test("blank scanned pages report OCR and dispose suppresses pending speech", async () => {
	const t = setup(async () => "  "); await t.reader.initialize(); t.reader.read(); await tick();
	assert.equal(t.speaks.length, 0); assert.equal(t.snapshot().status, "error"); assert.match(t.snapshot().message, /OCR/);
	t.reader.setPage(2); await tick(); assert.equal(t.speaks.length, 0);
	t.reader.dispose();
	let release: (value: string) => void = () => {};
	const pending = new Promise<string>(resolve => { release = resolve; });
	const d = setup(() => pending); await d.reader.initialize(); d.reader.read(); await tick();
	d.reader.dispose(); release("Never spoken"); await tick();
	assert.equal(d.speaks.length, 0);
});
