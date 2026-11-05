import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tinyPdf } from "../tests/helpers/tiny-pdf.ts";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const playwrightModule = process.env.LH_PLAYWRIGHT_MODULE;
const { _electron: electron } = await import(playwrightModule ? pathToFileURL(playwrightModule).href : "playwright");
const pdf = process.env.LH_TEST_PDF;
if (!pdf) throw new Error("Set LH_TEST_PDF to a local selectable PDF. This test never sends PDF content to a model.");
const profile = await mkdtemp(path.join(os.tmpdir(), "veil-study-ui-"));
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
let app;
let reader;
let finishSave;
const errors = [];
try {
	const packaged = Boolean(process.env.LH_TEST_EXECUTABLE);
	app = await electron.launch({ executablePath: process.env.LH_TEST_EXECUTABLE || require("electron"), cwd: root,
		args: [...(packaged ? [] : ["."]), `--user-data-dir=${profile}`],
		env: { ...process.env, LH_DEV_URL: packaged ? "" : process.env.LH_TEST_URL || "http://127.0.0.1:3215", LH_START_READER: "0", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000 });
	const workspace = await app.firstWindow();
	workspace.setDefaultTimeout(60000);
	await workspace.waitForLoadState("domcontentloaded");
	await workspace.waitForFunction(() => Boolean(window.lh?.overlay));
	const readerPromise = app.waitForEvent("window", { timeout: 30000 });
	await workspace.evaluate(() => window.lh.overlay.open());
	reader = await readerPromise;
	reader.setDefaultTimeout(30000);
	reader.on("pageerror", error => errors.push(error.message));
	await reader.waitForURL(/\/reader\/?$/);
	await reader.getByTestId("floating-reader").waitFor();
	await reader.waitForFunction(() => { const input = document.querySelector('[data-testid="reader-opacity"]'); return Boolean(input && !input.disabled); });
	await app.evaluate(({ BrowserWindow }) => {
		for (const win of BrowserWindow.getAllWindows()) { win.webContents.setBackgroundThrottling(false); if (!win.webContents.getURL().includes("/reader")) win.hide(); }
	});
	await reader.screenshot({ path: path.join(results, "reader-empty.png") });
	console.log("PASS: trusted native reader starts with separate workspace and clean empty state.");

	await reader.getByTestId("reader-file-input").setInputFiles(pdf);
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	const pageCount = await reader.locator('[aria-label="PDF page number"]').getAttribute("max");
	assert.ok(Number(pageCount) >= 2);
	console.log(`PASS: local PDF renders selectable text (${pageCount} pages).`);

	const oldPage = await reader.locator('[data-page="1"]').elementHandle();
	await reader.getByTestId("reader-file-input").setInputFiles(pdf);
	await reader.waitForFunction(node => !node.isConnected, oldPage);
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	console.log("PASS: a second import replaces the PDF cleanly.");

	await reader.getByTestId("reader-opacity").fill("62");
	await reader.getByTestId("reader-opacity").dispatchEvent("input");
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-opacity"]').value === "62");
	const nativeOpacity = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("/reader")).getOpacity());
	assert.ok(Math.abs(nativeOpacity - .62) < .015, `Native opacity changed: ${nativeOpacity}`);
	await reader.getByTestId("reader-opacity").fill("100");
	await reader.getByTestId("reader-opacity").dispatchEvent("input");
	await reader.getByTestId("reader-pin").click();
	assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("/reader")).isAlwaysOnTop()), false);
	await reader.getByTestId("reader-pin").click();
	await reader.getByTestId("reader-viewport").hover();
	await reader.mouse.wheel(0, 550);
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-viewport"]').scrollTop > 50);
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-page"]').value === "2");
	await reader.getByRole("button", { name: "Previous PDF page", exact: true }).click();
	console.log("PASS: native opacity, pinning, hover scrolling and page navigation.");

	async function choosePassage(mode = "teach") {
		const span = reader.locator('[data-page="1"] .textLayer span').filter({ hasText: /\S.{25}/ }).first();
		await span.scrollIntoViewIfNeeded();
		await span.evaluate(node => {
			const range = document.createRange(); range.selectNodeContents(node);
			const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
		});
		const selected = await reader.evaluate(() => window.getSelection().toString());
		await span.click({ button: "right" });
		await reader.getByTestId("reader-context-menu").waitFor();
		await reader.getByRole("menuitem", { name: mode === "practice" ? "Practice this passage" : "Study this passage", exact: true }).click();
		await reader.getByTestId("reader-study-bubble").waitFor();
		return selected;
	}
	await choosePassage();
	await reader.getByTestId("reader-start-study").click();
	await reader.getByRole("alert").filter({ hasText: "Configure" }).waitFor();
	console.log("PASS: unconfigured models are explained without creating an empty session.");
	await reader.getByRole("button", { name: "Close passage bubble" }).click();

	const chats = [];
	const inputs = [];
	const studyLinks = new Map();
	let savedReading;
	let saveCount = 0;
	const savePending = Promise.withResolvers();
	const saveGate = new Promise(resolve => { finishSave = resolve; });
	const models = Object.fromEntries(["strong", "cheap", "vision"].map(slot => [slot, { model: { provider: "mock", id: "mock-model" } }]));
	await reader.route("**/api/settings", route => route.fulfill({ json: { settings: { models } } }));
	await reader.route("**/api/chats", async route => {
		if (route.request().method() === "POST") {
			const request = route.request().postDataJSON();
			const chat = { id: `chat_reader_${chats.length + 1}`, title: request.title, kind: request.kind || "teach", busy: true, compacting: false, pendingQuestion: false, pendingProblem: false };
			chats.push(chat); await route.fulfill({ json: { id: chat.id, title: chat.title } });
		} else await route.fulfill({ json: { chats } });
	});
	await reader.route("**/api/reader/studies", async route => {
		if (route.request().method() === "POST") {
			for (const record of route.request().postDataJSON().records) studyLinks.set(record.id, record);
		}
		if (packaged) { await route.continue(); return; }
		await route.fulfill({ json: { records: [...studyLinks.values()] } });
	});
	await reader.route("**/api/reader/sessions", async route => {
		const request = route.request();
		if (request.method() !== "POST") {
			if (packaged) { await route.continue(); return; }
			await route.fulfill({ json: { sessions: savedReading ? [savedReading] : [] } });
			return;
		}
		saveCount++;
		if (!packaged) {
			try {
				const body = new Request(request.url(), { method: "POST", headers: request.headers(), body: request.postDataBuffer() });
				const form = await body.formData();
				const file = form.get("file");
				const state = JSON.parse(form.get("state"));
				const documentId = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
				const now = new Date().toISOString();
				savedReading = { ...state, id: "read_drag_fixture", documentId, documentName: file.name, createdAt: now, updatedAt: now, version: 1, attempts: [] };
			} catch (failure) { savePending.reject(failure); await route.abort(); return; }
		}
		savePending.resolve();
		await saveGate;
		if (packaged) { await route.continue(); return; }
		await route.fulfill({ json: { session: savedReading, fingerprint: "1".repeat(64) } });
	});
	await reader.route("**/api/chat", async route => { inputs.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
	const selected = await choosePassage();
	assert.equal(await reader.getByRole("checkbox", { name: "Use whole PDF", exact: true }).isChecked(), false);
	await reader.locator("#reader-question").fill("Help me understand this passage.");
	const beforeFocus = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL());
	await reader.getByTestId("reader-start-study").click();
	await reader.getByText("Study is running in the background.", { exact: true }).waitFor();
	await reader.getByTestId("reader-session-card").waitFor();
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0].input.type, "text");
	assert.ok(inputs[0].input.text.includes(selected));
	assert.equal(saveCount, 0, "Passage-only study does not save the PDF automatically");
	assert.match(inputs[0].input.text, /not instructions/);
	assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL()), beforeFocus, "Background admission does not change focus");
	assert.equal((await reader.getByTestId("reader-session-card").first().getAttribute("data-session-state")), "working");
	await reader.screenshot({ path: path.join(results, "reader-study-mocked.png") });
	await reader.getByRole("button", { name: "Close passage bubble" }).click();
	const dragPdf = Buffer.from(tinyPdf([{ runs: [
		{ text: "Alpha beta gamma delta begins the paragraph.", x: 60, y: 700, size: 16 },
		{ text: "Epsilon zeta eta theta.", x: 60, y: 673, size: 16 },
		{ text: "Right click here outside the selection.", x: 60, y: 643, size: 16 },
	] }]));
	await reader.getByTestId("reader-file-input").setInputFiles({ name: "Whole PDF drag fixture.pdf", mimeType: "application/pdf", buffer: dragPdf });
	const firstLine = reader.locator('[data-page="1"] .textLayer span').filter({ hasText: "Alpha beta gamma delta begins" });
	const lastLine = reader.locator('[data-page="1"] .textLayer span').filter({ hasText: "Epsilon zeta eta theta." });
	await firstLine.scrollIntoViewIfNeeded();
	const firstBox = await firstLine.boundingBox();
	const lastBox = await lastLine.boundingBox();
	assert.ok(firstBox && lastBox, "Both drag endpoints are rendered");
	await reader.mouse.move(firstBox.x + 1, firstBox.y + firstBox.height / 2);
	await reader.mouse.down();
	await reader.mouse.move(lastBox.x + lastBox.width - 1, lastBox.y + lastBox.height / 2, { steps: 15 });
	await reader.mouse.up();
	const dragged = await reader.evaluate(() => window.getSelection().toString().trim());
	assert.match(dragged, /Alpha beta gamma/);
	assert.match(dragged, /Epsilon zeta eta/);
	await reader.locator('[data-page="1"] .textLayer span').filter({ hasText: "Right click here outside the selection." }).click({ button: "right" });
	await reader.getByRole("menuitem", { name: "Practice this passage", exact: true }).click();
	assert.equal(await reader.getByTestId("reader-study-bubble").locator("blockquote").textContent(), dragged);
	await reader.getByRole("checkbox", { name: "Use whole PDF", exact: true }).check();
	const saveRequest = reader.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/reader/sessions", { timeout: 15000 });
	await reader.getByTestId("reader-start-practice").click();
	await saveRequest;
	await savePending.promise;
	assert.equal(inputs.length, 1, "Whole-PDF practice waits for the PDF save");
	assert.equal(saveCount, 1, "The opt-in saves the open PDF once");
	finishSave();
	await reader.getByText("Practice is running in the background.", { exact: true }).waitFor();
	assert.equal(inputs.length, 2);
	assert.equal(chats[1].kind, "practice");
	assert.equal(studyLinks.get(chats[1].id)?.documentId, createHash("sha256").update(dragPdf).digest("hex"));
	assert.ok(inputs[1].input.text.includes(JSON.stringify(dragged)));
	assert.equal(saveCount, 1);
	await reader.getByRole("button", { name: "Close passage bubble" }).click();
	await reader.getByTestId("reader-library").click();
	await reader.getByTestId("reader-saved-session").filter({ hasText: "Whole PDF drag fixture.pdf" }).waitFor();
	await reader.getByRole("button", { name: "Close reading panel" }).click();
	await choosePassage();
	assert.equal(await reader.getByRole("checkbox", { name: "Use whole PDF", exact: true }).isChecked(), false);
	await reader.getByRole("checkbox", { name: "Use whole PDF", exact: true }).check();
	await reader.getByTestId("reader-start-study").click();
	await reader.getByText("Study is running in the background.", { exact: true }).waitFor();
	assert.equal(inputs.length, 3);
	assert.equal(studyLinks.get(chats[2].id)?.documentId, studyLinks.get(chats[1].id)?.documentId);
	assert.equal(saveCount, 1, "The second opt-in reuses the saved PDF");
	assert.equal(await reader.getByTestId("reader-session-card").count(), 3);
	console.log("PASS: physical multiline selection survives right-click outside it, both whole-PDF modes use one saved document, and each new passage defaults to passage-only.");

	await reader.reload();
	await reader.getByTestId("reader-sessions").waitFor();
	await reader.waitForFunction(() => document.querySelectorAll('[data-testid="reader-session-card"]').length === 3);
	assert.equal(inputs.length, 3, "Reload does not submit a model turn again");
	await reader.getByTestId("reader-file-input").setInputFiles(pdf);
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	assert.equal(await reader.getByTestId("reader-session-card").count(), 3);
	await reader.getByTestId("reader-file-input").setInputFiles({ name: "another-document.pdf", mimeType: "application/pdf", buffer: await readFile(pdf) });
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	assert.equal(await reader.getByTestId("reader-session-card").count(), 3, "Opening another PDF keeps background work visible");
	assert.deepEqual(errors, []);
	console.log("PASS: source-linked history survives reload and PDF reopen; no uncaught renderer errors or real model requests.");
} catch (error) {
	if (reader) {
		console.error("Reader status:", await reader.locator('[role="status"]').allTextContents().catch(() => []));
		console.error("Renderer errors:", errors);
		await reader.screenshot({ path: path.join(results, "reader-failure.png"), timeout: 5000 }).catch(() => {});
	}
	throw error;
} finally {
	finishSave?.();
	if (app) await app.close();
	for (const testProfile of [profile, `${profile}-dev`]) {
		const absolute = path.resolve(testProfile);
		if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-study-ui-")) {
			await rm(absolute, { recursive: true, force: true }).catch(() => {});
		}
	}
}
