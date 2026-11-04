import assert from "node:assert/strict";
import { neuralStatus, synthesizeNeural } from "../src/server/reader-neural-speech.ts";
const status = neuralStatus();
assert.equal(status.ready, true, "Install local neural voices first, or set LH_READER_VOICE_DIR to their cache.");
for (const [voice, text] of [["English · LJ (neural)", "A desktop computer can run several tasks."], ["Svenska · Alma (neural)", "En dator kan köra flera program samtidigt."]]) {
	const start = Date.now();
	const wave = await synthesizeNeural({ voice, text, rate: 0 });
	assert.equal(wave.subarray(0, 4).toString(), "RIFF"); assert.equal(wave.subarray(8, 12).toString(), "WAVE");
	assert.equal(wave.readUInt32LE(4), wave.length - 8); assert.ok(wave.length > 20_000);
	console.log(`PASS: ${voice}, ${wave.length} WAV bytes, ${Date.now() - start} ms, no speaker audio or external request.`);
}
const abort = new AbortController();
const pending = synthesizeNeural({ voice: "English · LJ (neural)", text: "A longer sentence tests immediate cancellation. ".repeat(10), rate: 0 }, abort.signal);
setTimeout(() => abort.abort(), 20);
await assert.rejects(pending, /stopped/);
console.log("PASS: cancellation terminates local inference and cleans its temporary audio.");
