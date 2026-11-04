/** Real Windows speech gate. All output goes to WAV; never to the speakers. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { createSpeechController } = require("../electron/speech.cjs");

if (process.platform !== "win32") {
	console.log("SKIP: the native read-aloud smoke requires Windows.");
} else {
	const directory = await mkdtemp(path.join(os.tmpdir(), "veil-speech-smoke-"));
	const outputFile = path.join(directory, "speech.wav");
	const events = [];
	const speech = createSpeechController({ outputFile, onState: state => events.push(state) });
	async function completed(requestId) {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (events.some(state => state.requestId === requestId && state.status === "idle")) return;
			if (events.some(state => state.requestId === requestId && state.status === "error")) throw new Error("Native speech failed.");
			await delay(25);
		}
		throw new Error(`Native speech did not complete: ${requestId}`);
	}
	try {
		const voices = await speech.voices();
		assert.ok(voices.length, "at least one enabled Windows desktop voice is installed");
		const voice = voices.find(value => value.language === "en-US")?.name ?? voices[0].name;
		const speak = (requestId, text, rate = 0) => speech.speak({ requestId, text, voice, rate });
		assert.ok(["speaking", "idle"].includes((await speak("natural", "Read aloud is ready.")).status));
		await completed("natural");
		assert.deepEqual(speech.state(), { status: "idle", requestId: "natural" });
		console.log("PASS: installed voices and natural completion retain the page request ID.");

		const longPage = "This long page tests cancellation without sending text to a service. ".repeat(900);
		assert.equal((await speak("controls", longPage, -2)).status, "speaking");
		assert.equal((await speech.pause()).status, "paused");
		assert.equal((await speech.resume()).status, "speaking");
		assert.equal((await speech.pause()).status, "paused");
		await delay(100); // Let any already-generated samples flush before measuring.
		const pausedBytes = (await stat(outputFile)).size;
		assert.equal((await speech.stop()).status, "idle");
		await delay(100);
		assert.equal((await stat(outputFile)).size, pausedBytes, "cancelling while paused generates no additional old-page audio");
		await speak("after_paused_cancel", "The new page is ready.");
		await completed("after_paused_cancel");
		console.log("PASS: pause, resume, silent paused cancellation, and a new page after cancellation.");

		const first = speak("race_a", longPage);
		const stop = speech.stop();
		const last = speak("race_b", "The final selected page.");
		const results = await Promise.all([first, stop, last]);
		assert.equal(results[0].status, "idle", "superseded page A never starts");
		assert.equal(results[1].status, "idle");
		assert.ok(["speaking", "idle"].includes(results[2].status));
		await completed("race_b");
		assert.deepEqual(speech.state(), { status: "idle", requestId: "race_b" });
		console.log("PASS: rapid page A / Stop / page B resolves to B without stale completion.");
		speech.dispose();
		await delay(100);
		const wave = await readFile(outputFile);
		assert.equal(wave.subarray(0, 4).toString("ascii"), "RIFF");
		assert.equal(wave.subarray(8, 12).toString("ascii"), "WAVE");
		assert.ok(wave.length > 1000, "real native audio samples were synthesized");
		assert.equal(wave.readUInt32LE(4), wave.length - 8, "WAV header is finalized");
		console.log("PASS: native audio is a valid WAV; no audio device was used.");
	} finally {
		speech.dispose();
		const absolute = path.resolve(directory);
		if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-speech-smoke-")) await rm(absolute, { recursive: true, force: true });
	}
}
