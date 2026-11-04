import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tinyPdf } from "../tests/helpers/tiny-pdf.ts";
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const { _electron: electron } = await import(pathToFileURL(process.env.LH_PLAYWRIGHT_MODULE).href);
const profile = await mkdtemp(path.join(os.tmpdir(), "veil-workspace-ui-"));
const results = path.join(root, "test-results"); await mkdir(results, { recursive: true });
let app, reader;
const errors = [];
const fixture = Buffer.from(tinyPdf([
	{ runs: [{ text: "A desk-", x: 60, y: 700, size: 16 }, { text: "top computer runs applications. Explain the main idea.", x: 60, y: 675, size: 16 }] },
	{ runs: [{ text: "En dator kan kora flera program samtidigt.", x: 60, y: 700, size: 16 }] },
	{ image: true },
]));
async function launch() {
	const packaged = Boolean(process.env.LH_TEST_EXECUTABLE);
	app = await electron.launch({ executablePath: process.env.LH_TEST_EXECUTABLE || require("electron"), cwd: root, args: [...(packaged ? [] : ["."]), `--user-data-dir=${profile}`], env: { ...process.env, LH_DEV_URL: packaged ? "" : process.env.LH_TEST_URL || "http://127.0.0.1:3216", LH_START_READER: "1", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000 });
	reader = await app.firstWindow({ timeout: 60000 }); reader.setDefaultTimeout(45000);
	await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false); });
	reader.on("pageerror", error => errors.push(error.message));
	await reader.addInitScript(() => { const OriginalAudio = window.Audio; window.Audio = function(...args) { const audio = new OriginalAudio(...args); audio.muted = true; return audio; }; });
	await reader.reload();
	await reader.getByTestId("floating-reader").waitFor();
	await reader.waitForFunction(() => [...document.querySelector('[data-testid="reader-speech-voice"]').options].some(option => option.value.includes("Alma")));
}
try {
	await launch();
	await reader.getByTestId("reader-file-input").setInputFiles({ name: "Reading workspace example.pdf", mimeType: "application/pdf", buffer: fixture });
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	await reader.getByTestId("reader-speech-start").click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-status"]').dataset.state === "speaking");
	await reader.locator('[data-page="1"] [data-speech-markers] i').first().waitFor();
	await reader.getByTestId("reader-speech-pause").click();
	await reader.getByRole("button", { name: "Resume reading aloud", exact: true }).waitFor();
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await reader.getByTestId("reader-speech-voice").selectOption("Svenska · Alma (neural)");
	assert.equal(await reader.getByTestId("reader-speech-status").getAttribute("data-state"), "paused");
	await reader.getByTestId("reader-speech-pause").click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-status"]').dataset.state === "speaking");
	await reader.locator('[data-page="2"] [data-speech-markers] i').first().waitFor();
	await reader.getByTestId("reader-speech-stop").click();
	assert.equal(await reader.locator('[data-speech-markers] i').count(), 0);
	console.log("PASS: real English/Swedish neural WAV playback (muted), sentence tracking, paused page change, resume and cancellation.");

	await reader.getByTestId("reader-speech-rate").selectOption("2");
	await reader.getByTestId("reader-save").click();
	await reader.getByTestId("reader-save").filter({ hasText: "Saved" }).waitFor();
	await reader.getByTestId("reader-check-open").click();
	await reader.getByTestId("reader-rephrase").fill("The page explains that a computer can run more than one program at a time.");
	await reader.getByTestId("reader-check-submit").click();
	await reader.getByRole("alert").filter({ hasText: /Configure a strong model|Connect the selected/ }).waitFor();
	await reader.getByRole("button", { name: "Close reading panel", exact: true }).click();
	await new Promise(resolve => setTimeout(resolve, 800));
	if (process.env.LH_TEST_EXECUTABLE) { await app.close(); app = null; await launch(); }
	else await reader.reload();
	await reader.getByTestId("reader-library").click();
	await reader.getByTestId("reader-saved-session").filter({ hasText: "Reading workspace example.pdf" }).first().click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-page"]').value === "2");
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-speech-voice"]').value === "Svenska · Alma (neural)");
	assert.equal(await reader.getByTestId("reader-speech-rate").inputValue(), "2");
	assert.equal(await reader.getByTestId("reader-speech-status").getAttribute("data-state"), "idle");
	await reader.getByTestId("reader-check-open").click();
	assert.match(await reader.getByTestId("reader-rephrase").inputValue(), /more than one program/);
	console.log(`PASS: local PDF/progress/voice/speed/draft survive ${process.env.LH_TEST_EXECUTABLE ? "full app/server restart" : "renderer reload"}; resume is silent; missing model guidance preserves the draft.`);

	let submitted;
	await reader.route("**/api/reader/check", async route => {
		submitted = route.request().postDataJSON();
		await route.fulfill({ json: { attempt: { id: submitted.requestId, page: submitted.page, chapter: submitted.chapter, rephrase: submitted.rephrase, language: submitted.language, status: "complete", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { summary: "Your rephrase captures the main idea.", accurate: [{ text: "Several programs can run on one computer.", pages: [2] }], missing: [{ text: "Explain what makes this useful.", pages: [2] }], corrections: [], followUpQuestion: "How could you apply this while studying?" } } } });
	});
	await reader.getByTestId("reader-check-submit").click();
	await reader.getByTestId("reader-feedback").filter({ hasText: "Your rephrase captures" }).waitFor();
	assert.equal(submitted.page, 2); assert.equal(submitted.chapterPages.length, 3);
	assert.match(submitted.chapterPages[0].text, /desktop/);
	assert.ok(submitted.pageText.includes("dator"));
	assert.equal(submitted.pageText, submitted.chapterPages[1].text);
	await reader.screenshot({ path: path.join(results, "reader-understanding.png") });
	await reader.getByRole("button", { name: "Close reading panel", exact: true }).click();
	await reader.screenshot({ path: path.join(results, "reader-neural-library.png") });
	assert.deepEqual(errors, []);
	console.log("PASS: rephrase submits current raw page plus bounded chapter context; grounded rubric, citations and one follow-up display (AI response mocked).");
} catch (error) {
	if (reader) { console.error("speech status", await reader.getByTestId("reader-speech-status").textContent().catch(() => "")); console.error("renderer errors", errors); await reader.screenshot({ path: path.join(results, "reader-workspace-failure.png") }).catch(() => {}); }
	throw error;
} finally {
	if (app) await app.close();
	for (const candidate of [profile, `${profile}-dev`]) {
		const absolute = path.resolve(candidate); if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-workspace-ui-")) await rm(absolute, { recursive: true, force: true }).catch(() => {});
	}
}
