"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn: nativeSpawn } = require("node:child_process");

const MAX_SPEECH_TEXT = 100_000;
const MAX_RESPONSE_BYTES = 65_536;
const STATE_STATUSES = new Set(["idle", "speaking", "paused", "error"]);

function validateSpeechInput(input) {
	if (!input || typeof input !== "object" || typeof input.text !== "string" || !input.text.trim()) throw new Error("This page has no readable text. Scanned pages need OCR first.");
	if (input.text.length > MAX_SPEECH_TEXT) throw new Error("This page is too long to read aloud (maximum 100,000 characters).");
	if (typeof input.voice !== "string" || !input.voice.trim() || input.voice.length > 256) throw new Error("Choose an installed Windows voice.");
	if (!Number.isInteger(input.rate) || input.rate < -10 || input.rate > 10) throw new Error("Speech speed must be a whole number between -10 and 10.");
	if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)) throw new Error("Invalid speech request ID.");
	return { text: input.text, voice: input.voice, rate: input.rate, requestId: input.requestId };
}

function speechState(value) {
	if (!value || !STATE_STATUSES.has(value.status) || (value.requestId !== null && (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)))) throw new Error("Windows speech returned an invalid state.");
	return { status: value.status, requestId: value.requestId, ...(value.status === "error" ? { error: typeof value.error === "string" ? value.error.slice(0, 300) : "Windows could not read this page." } : {}) };
}

/** One lazy, private native worker. No PDF content appears in argv or logs. */
function createSpeechController({
	spawn = nativeSpawn, platform = process.platform, env = process.env, onState = () => {},
	requestTimeoutMs = 15_000, startupTimeoutMs = 20_000, outputFile = "",
} = {}) {
	let worker = null;
	let ready = false;
	let startup = null;
	let settleStartup = null;
	let startupTimer = null;
	let sequence = 0;
	let generation = 0;
	let closed = false;
	let latestRequestId = null;
	let snapshot = { status: "idle", requestId: null };
	const pending = new Map();
	const state = () => ({ ...snapshot });
	function publish(value) {
		const next = speechState(value);
		if (next.requestId !== latestRequestId) return;
		snapshot = next;
		try { onState(state()); } catch { /* A closing renderer cannot retain the native worker. */ }
	}
	function disconnect(message, report = true) {
		const previous = worker;
		worker = null;
		ready = false;
		clearTimeout(startupTimer);
		startupTimer = null;
		settleStartup?.reject(new Error(message));
		settleStartup = null;
		startup = null;
		for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
		pending.clear();
		if (previous) { try { previous.stdin.end(); } catch {} try { previous.kill(); } catch {} }
		if (report && !closed) publish({ status: "error", requestId: latestRequestId, error: message });
	}
	function ensureWorker() {
		if (closed) return Promise.reject(new Error("Read aloud has been closed."));
		if (platform !== "win32") return Promise.reject(new Error("Local read aloud is currently available on Windows."));
		if (ready && worker) return Promise.resolve();
		if (startup) return startup;
		startup = new Promise((resolve, reject) => { settleStartup = { resolve, reject }; });
		const promise = startup;
		try {
			const source = fs.readFileSync(path.join(__dirname, "speech-worker.ps1"), "utf8");
			const executable = path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
			const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
				windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
				env: { ...env, VEIL_SPEECH_WAVE_OUTPUT: outputFile },
			});
			worker = child;
			let buffer = "";
			const fail = message => { if (worker === child) disconnect(message); };
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", chunk => {
				if (worker !== child) return;
				buffer += chunk;
				if (buffer.length > MAX_RESPONSE_BYTES) { fail("Windows speech returned an oversized response."); return; }
				let index;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index).replace(/^\uFEFF/, "").trim();
					buffer = buffer.slice(index + 1);
					if (!line) continue;
					try {
						const message = JSON.parse(line);
						if (message.event === "ready") {
							if (ready) continue;
							ready = true;
							clearTimeout(startupTimer); startupTimer = null;
							settleStartup?.resolve(); settleStartup = null; startup = null;
						} else if (message.event === "fatal") { fail("Windows speech could not be initialized."); return; }
						else if (message.event === "state") publish(message.value);
						else if (typeof message.id === "string" && pending.has(message.id)) {
							const entry = pending.get(message.id);
							pending.delete(message.id); clearTimeout(entry.timer);
							if (message.ok === true) entry.resolve(message.value);
							else entry.reject(new Error("Windows could not complete the speech request. Try another installed voice."));
						}
					} catch { fail("Windows speech returned an invalid response."); return; }
				}
			});
			child.stdin.on("error", () => fail("The Windows speech connection was interrupted."));
			child.on("error", () => fail("Windows speech could not be started."));
			child.on("exit", () => fail("Windows speech stopped unexpectedly. Try Read aloud again."));
			startupTimer = setTimeout(() => fail("Windows speech took too long to start. Try Read aloud again."), startupTimeoutMs);
		} catch { disconnect("Windows speech could not be started."); }
		return promise;
	}
	function send(op, input = {}) {
		const child = worker;
		if (!child || !ready) return Promise.reject(new Error("Windows speech is not ready."));
		const id = String(++sequence);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { if (worker === child) disconnect("Windows speech did not respond. Try Read aloud again."); }, requestTimeoutMs);
			pending.set(id, { resolve, reject, timer });
			try { child.stdin.write(`${JSON.stringify({ id, op, ...input })}\n`, "utf8", error => { if (error && worker === child) disconnect("The Windows speech connection was interrupted."); }); }
			catch { disconnect("The Windows speech connection was interrupted."); }
		});
	}
	async function control(op) {
		if (!worker || !ready) return state();
		// The worker emits state before its acknowledgement. A completion can
		// arrive in the same stdout chunk, so the older reply must not regress it.
		try { speechState(await send(op)); return state(); }
		catch (error) { return { status: "error", requestId: latestRequestId, error: error.message }; }
	}
	return {
		state,
		async voices() {
			await ensureWorker();
			const values = await send("voices");
			if (!Array.isArray(values) || values.length > 200 || values.some(value => !value || typeof value.name !== "string" || !value.name || value.name.length > 256 || typeof value.language !== "string" || value.language.length > 80)) throw new Error("Windows returned an invalid voice list.");
			return values.map(({ name, language }) => ({ name, language }));
		},
		async speak(raw) {
			const input = validateSpeechInput(raw);
			const owner = ++generation;
			latestRequestId = input.requestId;
			try {
				await ensureWorker();
				if (owner !== generation) return { status: "idle", requestId: input.requestId };
				const value = speechState(await send("speak", input));
				return owner === generation ? state() : value;
			} catch (error) {
				const value = { status: "error", requestId: input.requestId, error: error.message };
				if (owner === generation) publish(value);
				return value;
			}
		},
		pause: () => control("pause"),
		resume: () => control("resume"),
		async stop() {
			generation++;
			if (worker && !ready) disconnect("Read aloud was stopped.", false);
			if (worker && ready) return control("stop");
			publish({ status: "idle", requestId: latestRequestId });
			return state();
		},
		/** Reset is reusable after a reload; dispose permanently closes the owner. */
		reset() {
			generation++;
			disconnect("Read aloud was stopped.", false);
			publish({ status: "idle", requestId: latestRequestId });
		},
		dispose() {
			closed = true; generation++;
			disconnect("Read aloud has been closed.", false);
		},
	};
}

module.exports = { createSpeechController, validateSpeechInput, MAX_SPEECH_TEXT };
