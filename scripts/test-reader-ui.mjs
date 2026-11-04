import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
const errors = [];
try {
	app = await electron.launch({ executablePath: require("electron"), cwd: root,
		args: [".", `--user-data-dir=${profile}`],
		env: { ...process.env, LH_DEV_URL: process.env.LH_TEST_URL || "http://127.0.0.1:3215", LH_START_READER: "0", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000 });
	const workspace = await app.firstWindow();
	workspace.setDefaultTimeout(60000);
	await workspace.waitForLoadState("domcontentloaded");
	await workspace.waitForFunction(() => Boolean(window.lh?.overlay));
	const readerPromise = app.waitForEvent("window", { timeout: 30000 });
	await workspace.evaluate(() => window.lh.overlay.open());
	reader = await readerPromise;
	reader.setDefaultTimeout(30000);
	reader.on("pageerror", error => errors.push(error.message));
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
	const models = Object.fromEntries(["strong", "cheap", "vision"].map(slot => [slot, { model: { provider: "mock", id: "mock-model" } }]));
	await reader.route("**/api/settings", route => route.fulfill({ json: { settings: { models } } }));
	await reader.route("**/api/chats", async route => {
		if (route.request().method() === "POST") {
			const request = route.request().postDataJSON();
			const chat = { id: `chat_reader_${chats.length + 1}`, title: request.title, kind: request.kind || "teach", busy: true, compacting: false, pendingQuestion: false, pendingProblem: false };
			chats.push(chat); await route.fulfill({ json: { id: chat.id, title: chat.title } });
		} else await route.fulfill({ json: { chats } });
	});
	await reader.route("**/api/chat", async route => { inputs.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
	const selected = await choosePassage();
	await reader.locator("#reader-question").fill("Help me understand this passage.");
	const beforeFocus = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL());
	await reader.getByTestId("reader-start-study").click();
	await reader.getByText("Study is running in the background.", { exact: true }).waitFor();
	await reader.getByTestId("reader-session-card").waitFor();
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0].input.type, "text");
	assert.ok(inputs[0].input.text.includes(selected));
	assert.match(inputs[0].input.text, /not instructions/);
	assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL()), beforeFocus, "Background admission does not change focus");
	assert.equal((await reader.getByTestId("reader-session-card").first().getAttribute("data-session-state")), "working");
	await reader.screenshot({ path: path.join(results, "reader-study-mocked.png") });
	await reader.getByRole("button", { name: "Close passage bubble" }).click();
	await choosePassage("practice");
	await reader.getByTestId("reader-start-practice").click();
	await reader.getByText("Practice is running in the background.", { exact: true }).waitFor();
	assert.equal(inputs.length, 2);
	assert.equal(chats[1].kind, "practice");
	assert.equal(await reader.getByTestId("reader-session-card").count(), 2);
	console.log("PASS: study/practice submit selected text once, keep focus and retain independent background sessions.");

	await reader.reload();
	await reader.getByTestId("reader-sessions").waitFor();
	await reader.waitForFunction(() => document.querySelectorAll('[data-testid="reader-session-card"]').length === 2);
	assert.equal(inputs.length, 2, "Reload does not submit a model turn again");
	await reader.getByTestId("reader-file-input").setInputFiles(pdf);
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	assert.equal(await reader.getByTestId("reader-session-card").count(), 2);
	await reader.getByTestId("reader-file-input").setInputFiles({ name: "another-document.pdf", mimeType: "application/pdf", buffer: await readFile(pdf) });
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	assert.equal(await reader.getByTestId("reader-session-card").count(), 2, "Opening another PDF keeps background work visible");
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
	if (app) await app.close();
	for (const testProfile of [profile, `${profile}-dev`]) {
		const absolute = path.resolve(testProfile);
		if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-study-ui-")) {
			await rm(absolute, { recursive: true, force: true }).catch(() => {});
		}
	}
}
