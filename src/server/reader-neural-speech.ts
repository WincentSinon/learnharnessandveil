import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";
import { PATHS } from "../../config.ts";
import manifest from "../core/neural-voice-manifest.json";

export const neuralVoiceDirectory = () => process.env.LH_READER_VOICE_DIR || path.join(PATHS.data, "reader-voices");
const executable = () => path.join(neuralVoiceDirectory(), "piper", "piper.exe");
let installation: Promise<void> | undefined;
let installError = "";
let installMessage = "";
let active = 0;
export function neuralStatus() {
	const ready = process.platform === "win32" && existsSync(executable()) && manifest.voices.every(voice => existsSync(path.join(neuralVoiceDirectory(), voice.file)) && existsSync(path.join(neuralVoiceDirectory(), voice.config.file)));
	return { ready, installing: Boolean(installation), message: installError || installMessage, voices: ready ? manifest.voices.map(({ name, language }) => ({ name, language })) : [], downloadBytes: manifest.runtime.size + manifest.voices.reduce((sum, voice) => sum + voice.size, 0), attribution: manifest.voices.map(({ name, license }) => ({ name, license })) };
}
async function download(asset: { file: string; url: string; size: number; sha256: string }) {
	const target = path.join(neuralVoiceDirectory(), asset.file);
	try { const existing = await fs.readFile(target); if (existing.length === asset.size && createHash("sha256").update(existing).digest("hex") === asset.sha256) return; } catch { /* Download missing or damaged asset again. */ }
	installMessage = `Downloading ${asset.file}…`;
	const response = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`Voice download failed (${response.status}). Try again.`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Voice download integrity check failed. Try again.");
	await fs.writeFile(`${target}.part`, bytes); await fs.rename(`${target}.part`, target);
}
export function installNeuralVoices() {
	if (installation) return installation;
	if (process.platform !== "win32") return Promise.reject(new Error("Local neural voice setup currently supports Windows."));
	installError = "";
	installation = (async () => {
		await fs.mkdir(neuralVoiceDirectory(), { recursive: true });
		await download(manifest.runtime);
		const entries = unzipSync(await fs.readFile(path.join(neuralVoiceDirectory(), manifest.runtime.file)));
		for (const [name, bytes] of Object.entries(entries)) {
			const target = path.resolve(neuralVoiceDirectory(), name);
			if (!target.startsWith(`${path.resolve(neuralVoiceDirectory())}${path.sep}`) || name.split(/[\\/]/).includes("..")) throw new Error("Invalid voice runtime archive.");
			if (name.endsWith("/")) await fs.mkdir(target, { recursive: true });
			else { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
		}
		for (const voice of manifest.voices) {
			await download(voice); await download(voice.config);
			const card = await fetch(`https://huggingface.co/rhasspy/piper-voices/resolve/${manifest.revision}/${voice.folder}/MODEL_CARD`);
			if (!card.ok) throw new Error("Could not download voice attribution.");
			await fs.writeFile(path.join(neuralVoiceDirectory(), `${voice.id}-MODEL_CARD.txt`), await card.text());
		}
		installMessage = "Local neural voices are ready.";
	})().catch(error => { installError = error instanceof Error ? error.message : "Voice setup failed."; throw error; }).finally(() => { installation = undefined; });
	return installation;
}
export function neuralInput(raw: unknown) {
	const input = raw as { text: string; voice: string; rate: number };
	if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 700) throw new Error("Choose a speech segment of 1–700 characters.");
	const voice = manifest.voices.find(voice => voice.name === input.voice);
	if (!voice || ![-2, 0, 2, 4].includes(input.rate)) throw new Error("Choose a local neural voice and valid speed.");
	return { text: input.text.replace(/\s+/g, " ").trim(), voice, rate: input.rate };
}
export async function synthesizeNeural(raw: unknown, signal?: AbortSignal): Promise<Buffer> {
	const input = neuralInput(raw);
	if (!neuralStatus().ready) throw new Error("Install the local neural voices first.");
	const deadline = Date.now() + 5000;
	while (active >= 2 && Date.now() < deadline && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 25));
	if (signal?.aborted) throw new Error("Speech was stopped.");
	if (active >= 2) throw new Error("The local voice is busy. Try again in a moment.");
	active++;
	let directory: string | undefined;
	try {
		directory = await fs.mkdtemp(path.join(neuralVoiceDirectory(), "audio-"));
		const output = path.join(directory, "speech.wav");
		await new Promise<void>((resolve, reject) => {
			const length = new Map([[-2, 1.22], [0, 1], [2, .85], [4, .72]]).get(input.rate)!;
			const child = spawn(executable(), ["--model", path.join(neuralVoiceDirectory(), input.voice.file), "--config", path.join(neuralVoiceDirectory(), input.voice.config.file), "--output_file", output, "--length_scale", String(length), "--sentence_silence", "0.12"], { shell: false, windowsHide: true, cwd: path.dirname(executable()), stdio: ["pipe", "ignore", "pipe"] });
			let diagnostic = "";
			child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-800); });
			const abort = () => child.kill();
			const timer = setTimeout(abort, 45_000);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.once("error", reject);
			child.once("close", code => {
				clearTimeout(timer); signal?.removeEventListener("abort", abort);
				if (signal?.aborted) reject(new Error("Speech was stopped."));
				else if (code !== 0) reject(new Error(diagnostic.includes("phonem") ? "The voice could not pronounce this segment." : "Local neural synthesis did not complete."));
				else resolve();
			});
			child.stdin.on("error", () => {});
			child.stdin.end(`${input.text}\n`, "utf8");
		});
		const bytes = await fs.readFile(output);
		if (bytes.length > 20_000_000 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WAVE") throw new Error("Local voice returned invalid audio.");
		return bytes;
	} finally { active--; if (directory) await fs.rm(directory, { recursive: true, force: true }); }
}
