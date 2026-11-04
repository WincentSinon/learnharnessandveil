import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tinyPdf } from "../tests/helpers/tiny-pdf.ts";

// A real Electron/PDF integration with a deterministic speech transport.
// Native Windows synthesis is tested separately; this suite never plays audio.
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const modulePath = process.env.LH_PLAYWRIGHT_MODULE;
const { _electron: electron } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const profile = await mkdtemp(path.join(os.tmpdir(), "veil-study-speech-ui-"));
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
let app;
let reader;
const errors = [];
try {
	const packaged = Boolean(process.env.LH_TEST_EXECUTABLE);
	app = await electron.launch({
		executablePath: process.env.LH_TEST_EXECUTABLE || require("electron"), cwd: root,
		args: [...(packaged ? [] : ["."]), `--user-data-dir=${profile}`],
		env: { ...process.env, LH_DEV_URL: packaged ? "" : process.env.LH_TEST_URL || "http://127.0.0.1:3216", LH_START_READER: "1", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000,
	});
	reader = await app.firstWindow({ timeout: 60000 });
	reader.setDefaultTimeout(30000);
	reader.on("pageerror", error => errors.push(error.message));
	await reader.waitForURL(/\/reader\/?$/);
	await app.evaluate(({ ipcMain }) => {
		globalThis.__speechTest = { calls: [], state: { status: "idle", requestId: null }, sender: null };
		ipcMain.removeHandler("lh:overlay:speech");
		ipcMain.handle("lh:overlay:speech", async (event, input) => {
			const fixture = globalThis.__speechTest;
			fixture.sender = event.sender;
			fixture.calls.push(structuredClone(input));
			if (input.op === "voices") return [
				{ name: "Microsoft Zira Desktop", language: "en-US" },
				{ name: "Microsoft Bengt", language: "sv-SE" },
				{ name: "Microsoft Pattara", language: "th-TH" },
			];
			if (input.op === "state") return fixture.state;
			if (input.op === "speak") fixture.state = { status: "speaking", requestId: input.requestId };
			if (input.op === "pause") fixture.state = { ...fixture.state, status: "paused" };
			if (input.op === "resume") fixture.state = { ...fixture.state, status: "speaking" };
			if (input.op === "stop") fixture.state = { ...fixture.state, status: "idle" };
			event.sender.send("lh:overlay:speech-state", fixture.state);
			return fixture.state;
		});
	});
	await reader.reload();
	await reader.getByTestId("reader-speech-start").waitFor();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-voice"]')?.options.length === 3);
	assert.equal(await reader.getByTestId("reader-speech-start").isDisabled(), true);
	const fixture = Buffer.from(tinyPdf([
		{ runs: [{ text: "Alpha. Read only the current page.", x: 60, y: 700, size: 16 }] },
		{ runs: [{ text: "Beta. Follow the page I navigate to.", x: 60, y: 700, size: 16 }] },
		{ image: true },
	]));
	const openFixture = async (name = "Read aloud example.pdf") => {
		await reader.getByTestId("reader-file-input").setInputFiles({ name, mimeType: "application/pdf", buffer: fixture });
		await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	};
	const speechCalls = () => app.evaluate(() => globalThis.__speechTest.calls.filter(call => call.op === "speak"));
	const state = () => app.evaluate(() => globalThis.__speechTest.state);
	const waitCount = async count => {
		await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-status"]')?.textContent?.match(/reading|speaking/i));
		for (let attempt = 0; attempt < 100; attempt++) {
			const calls = await speechCalls();
			if (calls.length === count) return calls;
			await new Promise(resolve => setTimeout(resolve, 30));
		}
		assert.equal((await speechCalls()).length, count);
	};
	await openFixture();
	await reader.getByTestId("reader-speech-start").click();
	let calls = await waitCount(1);
	assert.match(calls[0].text, /Alpha/);
	await reader.getByTestId("reader-speech-pause").click();
	await reader.getByRole("button", { name: "Resume reading aloud", exact: true }).waitFor();
	assert.equal((await state()).status, "paused");
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-page"]').value === "2");
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-status"]')?.textContent?.match(/paused/i));
	await new Promise(resolve => setTimeout(resolve, 450));
	assert.equal((await speechCalls()).length, 1, "Page navigation while paused stays silent");
	await reader.getByTestId("reader-speech-pause").click();
	calls = await waitCount(2);
	assert.match(calls[1].text, /Beta/);
	assert.notEqual(calls[1].requestId, calls[0].requestId);
	console.log("PASS: reads current page; pause stays silent through navigation; resume reads newly visible page.");

	await reader.getByRole("button", { name: "Previous PDF page", exact: true }).click();
	calls = await waitCount(3);
	assert.match(calls[2].text, /Alpha/);
	await reader.getByTestId("reader-viewport").evaluate(viewport => {
		viewport.scrollTop = document.querySelector('[data-page="2"]').offsetTop - 20;
	});
	calls = await waitCount(4);
	assert.match(calls[3].text, /Beta/);
	await app.evaluate(() => {
		const fixture = globalThis.__speechTest;
		fixture.sender.send("lh:overlay:speech-state", { status: "idle", requestId: fixture.calls.find(call => call.op === "speak").requestId });
	});
	assert.equal((await state()).status, "speaking", "Old completion does not stop the current request");
	await reader.getByTestId("reader-speech-voice").selectOption("Microsoft Bengt");
	calls = await waitCount(5);
	assert.equal(calls[4].voice, "Microsoft Bengt");
	await reader.getByTestId("reader-speech-rate").selectOption("2");
	calls = await waitCount(6);
	assert.equal(calls[5].rate, 2);
	await reader.getByTestId("reader-speech-stop").click();
	await reader.waitForFunction(() => !document.querySelector('[data-testid="reader-speech-start"]').disabled);
	await reader.getByRole("button", { name: "Previous PDF page", exact: true }).click();
	await new Promise(resolve => setTimeout(resolve, 450));
	assert.equal((await speechCalls()).length, 6, "Stop disarms page following");
	console.log("PASS: active navigation and scrolling switch speech, late completion is ignored, voice/speed work, Stop disarms following.");

	await reader.getByTestId("reader-speech-start").click();
	await waitCount(7);
	await app.evaluate(() => {
		const fixture = globalThis.__speechTest;
		fixture.state = { ...fixture.state, status: "idle" };
		fixture.sender.send("lh:overlay:speech-state", fixture.state);
	});
	await reader.waitForFunction(() => !document.querySelector('[data-testid="reader-speech-start"]').disabled);
	assert.equal(await reader.getByTestId("reader-page").inputValue(), "1", "Completion never turns the page");
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await new Promise(resolve => setTimeout(resolve, 450));
	assert.equal((await speechCalls()).length, 7, "Page end disarms following");
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await reader.getByTestId("reader-speech-start").click();
	await reader.getByTestId("reader-speech-status").filter({ hasText: /no.*text|OCR|scanned/i }).waitFor();
	assert.equal((await speechCalls()).length, 7, "Image-only pages are never sent to speech");
	console.log("PASS: end of page stops without advancing; scanned pages explain missing text.");

	await openFixture();
	await reader.getByTestId("reader-speech-start").click();
	await waitCount(8);
	await openFixture("Replacement PDF.pdf");
	assert.equal((await state()).status, "idle", "Replacing the PDF stops old audio");
	await reader.getByTestId("reader-speech-start").click();
	await waitCount(9);
	await reader.getByTestId("reader-speech-stop").click();
	await reader.screenshot({ path: path.join(results, "reader-read-aloud.png") });
	if (process.env.LH_TEST_PDF) {
		await reader.getByTestId("reader-file-input").setInputFiles(process.env.LH_TEST_PDF);
		await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
		await reader.getByTestId("reader-speech-start").click();
		calls = await waitCount(10);
		assert.ok(calls[9].text.trim().length > 0);
		await reader.getByTestId("reader-speech-stop").click();
	}
	assert.deepEqual(errors, []);
	console.log("PASS: replacement cancels old speech; local test PDF extracts readable page text without a model or upload.");
} catch (error) {
	if (reader) {
		console.error("Speech status:", await reader.getByTestId("reader-speech-status").textContent().catch(() => "unavailable"));
		console.error("Renderer errors:", errors);
		await reader.screenshot({ path: path.join(results, "reader-speech-failure.png"), timeout: 5000 }).catch(() => {});
	}
	throw error;
} finally {
	if (app) await app.close();
	for (const candidate of [profile, `${profile}-dev`]) {
		const absolute = path.resolve(candidate);
		if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-study-speech-ui-")) {
			await rm(absolute, { recursive: true, force: true }).catch(() => {});
		}
	}
}
