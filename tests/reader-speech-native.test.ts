import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createSpeechController, validateSpeechInput, MAX_SPEECH_TEXT } = require("../electron/speech.cjs");
const input = { text: "A readable page.", voice: "Microsoft Zira Desktop", rate: 0, requestId: "page_1" };

test("native speech validates size, voice, rate and opaque request identity before spawning", () => {
	assert.deepEqual(validateSpeechInput(input), input);
	for (const text of ["", " \n", "x".repeat(MAX_SPEECH_TEXT + 1), null]) assert.throws(() => validateSpeechInput({ ...input, text }), /readable|too long/);
	for (const voice of ["", "x".repeat(257), null]) assert.throws(() => validateSpeechInput({ ...input, voice }), /installed Windows voice/);
	for (const rate of [NaN, 0.5, "0", -11, 11]) assert.throws(() => validateSpeechInput({ ...input, rate }), /whole number/);
	for (const requestId of ["", "../page", "x".repeat(101), null]) assert.throws(() => validateSpeechInput({ ...input, requestId }), /request ID/);
});

class SpeechWorker extends EventEmitter {
	stdout = new PassThrough();
	stdin: Writable;
	killed = false;
	commands: Array<Record<string, unknown>> = [];
	current = { status: "idle", requestId: null as string | null };
	handle: ((command: Record<string, unknown>) => void) | undefined;
	constructor() {
		super();
		this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
			const command = JSON.parse(String(chunk));
			this.commands.push(command);
			queueMicrotask(() => { if (this.handle) this.handle(command); else this.answer(command); });
			callback();
		} });
	}
	message(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
	answer(command: Record<string, unknown>) {
		if (command.op === "voices") { this.message({ id: command.id, ok: true, value: [{ name: input.voice, language: "en-US" }] }); return; }
		if (command.op === "speak") this.current = { status: "speaking", requestId: command.requestId as string };
		if (command.op === "pause") this.current.status = "paused";
		if (command.op === "resume") this.current.status = "speaking";
		if (command.op === "stop") this.current.status = "idle";
		this.message({ event: "state", value: this.current });
		this.message({ id: command.id, ok: true, value: this.current });
	}
	kill() { this.killed = true; this.emit("exit", 0); return true; }
}

function fixture(options: Record<string, unknown> = {}) {
	const workers: SpeechWorker[] = [];
	const spawns: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
	const states: Array<{ status: string; requestId: string | null }> = [];
	const controller = createSpeechController({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, onState: (state: { status: string; requestId: string | null }) => states.push(state),
		spawn(executable: string, args: string[], spawnOptions: Record<string, unknown>) {
			const worker = new SpeechWorker(); workers.push(worker); spawns.push({ executable, args, options: spawnOptions });
			queueMicrotask(() => worker.message({ event: "ready" }));
			return worker;
		}, ...options,
	});
	return { controller, workers, spawns, states };
}

test("speech sends PDF text only on stdin, controls playback, and ignores stale completion", async t => {
	const { controller, workers, spawns, states } = fixture();
	t.after(() => controller.dispose());
	assert.deepEqual(await controller.voices(), [{ name: input.voice, language: "en-US" }]);
	const text = 'Quotes " ` $(code) <speak>plain PDF text</speak> ภาษาไทย';
	assert.equal((await controller.speak({ ...input, text })).status, "speaking");
	assert.equal((await controller.pause()).status, "paused");
	assert.equal((await controller.resume()).status, "speaking");
	await controller.speak({ ...input, requestId: "page_2" });
	workers[0]!.message({ event: "state", value: { status: "idle", requestId: "page_1" } });
	assert.equal(controller.state().requestId, "page_2");
	assert.equal(controller.state().status, "speaking");
	workers[0]!.message({ event: "state", value: { status: "idle", requestId: "page_2" } });
	assert.deepEqual(controller.state(), { status: "idle", requestId: "page_2" });
	assert.equal((await controller.stop()).status, "idle");
	assert.equal(states.at(-1)?.requestId, "page_2");
	assert.equal(spawns.length, 1, "one worker is shared across page changes");
	assert.equal(spawns[0]!.options.windowsHide, true);
	assert.equal(spawns[0]!.options.shell, false);
	assert.equal(spawns[0]!.args.includes(text), false);
	assert.equal(workers[0]!.commands.find(command => command.op === "speak")?.text, text);
	assert.ok(Buffer.from(spawns[0]!.args.at(-1)!, "base64").toString("utf16le").includes("SpeakAsync"));
});

test("rapid pending page starts are superseded and stop does not revive earlier speech", async t => {
	const { controller, workers } = fixture();
	t.after(() => controller.dispose());
	const first = controller.speak(input);
	const stop = controller.stop();
	const last = controller.speak({ ...input, requestId: "page_2" });
	const results = await Promise.all([first, stop, last]);
	assert.equal(results[0].status, "error", "interrupted worker startup is rejected");
	assert.equal(results[1].status, "idle");
	assert.equal(results[2].status, "speaking");
	assert.equal(workers[0]!.killed, true);
	assert.deepEqual(workers[1]!.commands.filter(command => command.op === "speak").map(command => command.requestId), ["page_2"]);
});

test("coalesced acceptance and natural completion cannot restore an older speaking snapshot", async t => {
	const { controller, workers } = fixture();
	t.after(() => controller.dispose());
	await controller.voices();
	workers[0]!.handle = command => {
		const speaking = { status: "speaking", requestId: command.requestId };
		const idle = { status: "idle", requestId: command.requestId };
		workers[0]!.stdout.write([
			{ event: "state", value: speaking },
			{ id: command.id, ok: true, value: speaking },
			{ event: "state", value: idle },
		].map(value => JSON.stringify(value)).join("\n") + "\n");
	};
	assert.deepEqual(await controller.speak(input), { status: "idle", requestId: input.requestId });
	assert.deepEqual(controller.state(), { status: "idle", requestId: input.requestId });
});

test("worker failure rejects pending controls and a later attempt starts a fresh worker", async t => {
	const { controller, workers } = fixture();
	t.after(() => controller.dispose());
	await controller.voices();
	workers[0]!.handle = () => workers[0]!.emit("exit", 1);
	assert.equal((await controller.speak(input)).status, "error");
	assert.equal(controller.state().status, "error");
	assert.equal((await controller.speak({ ...input, requestId: "retry" })).status, "speaking");
	assert.equal(workers.length, 2);
	controller.reset();
	assert.equal(workers[1]!.killed, true);
	assert.equal(controller.state().status, "idle");
});

test("a silent worker times out without leaving a process or pending promise", async () => {
	const { controller, workers } = fixture({ requestTimeoutMs: 10 });
	await controller.voices();
	workers[0]!.handle = () => {};
	await assert.rejects(controller.voices(), /did not respond/);
	assert.equal(workers[0]!.killed, true);
	controller.dispose();
});

test("unsupported platforms and disposed owners never spawn speech workers", async () => {
	let spawns = 0;
	const controller = createSpeechController({ platform: "darwin", spawn: () => { spawns++; } });
	await assert.rejects(controller.voices(), /available on Windows/);
	controller.dispose();
	await assert.rejects(controller.voices(), /closed/);
	assert.equal(spawns, 0);
});
