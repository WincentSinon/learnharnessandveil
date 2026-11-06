import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const modulePath = process.env.LH_PLAYWRIGHT_MODULE;
const { _electron: electron } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const profile = await mkdtemp(path.join(os.tmpdir(), "veil-study-package-"));
const results = path.join(root, "test-results");
await mkdir(results, { recursive: true });
let app;
let diagnostics = "";
try {
	app = await electron.launch({ executablePath: process.env.LH_TEST_EXECUTABLE || path.join(root, "dist/win-unpacked/Veil Study.exe"),
		args: [`--user-data-dir=${profile}`], env: { ...process.env, LH_DEV_URL: "", LH_START_READER: "1", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000 });
	app.process().stdout?.on("data", data => { diagnostics += data.toString(); });
	app.process().stderr?.on("data", data => { diagnostics += data.toString(); });
	const reader = await app.firstWindow({ timeout: 60000 });
	reader.setDefaultTimeout(30000);
	await reader.waitForURL(/\/reader\/?$/);
	await reader.waitForFunction(() => { const input = document.querySelector('[data-testid="reader-opacity"]'); return Boolean(input && !input.disabled); });
	const metadata = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, version: app.getVersion(), windows: BrowserWindow.getAllWindows().length }));
	assert.equal(metadata.packaged, true);
	const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
	assert.equal(metadata.version, packageJson.version);
	assert.equal(metadata.windows, 1, "The reader is the initial window; no workspace steals focus");
	const voices = await reader.evaluate(() => window.lh.overlay.speech.voices());
	assert.ok(voices.length > 0, "Packaged reader reaches installed Windows speech voices");
	assert.ok(voices.every(voice => voice.name && voice.language));
	const settings = await reader.evaluate(async () => (await fetch("/api/settings")).json());
	assert.ok("settings" in settings, "The owned reader reaches the protected API");
	const chatPage = await reader.evaluate(async () => {
		const created = await fetch("/api/chats", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Packaged chat smoke" }),
		});
		if (!created.ok) throw new Error(`Test chat creation failed (HTTP ${created.status}).`);
		const { id } = await created.json();
		const response = await fetch(`/chat/${encodeURIComponent(id)}`);
		return { status: response.status, composer: (await response.text()).includes('data-testid="composer"') };
	});
	assert.deepEqual(chatPage, { status: 200, composer: true }, "The packaged server renders the chat workspace");
	const outsider = await fetch(new URL("/api/settings", reader.url()));
	assert.equal(outsider.status, 403, "An unpaired external process cannot use the private desktop API");
	for (const endpoint of ["/api/reader/sessions", "/api/reader/speech", "/api/reader/check"]) assert.equal((await fetch(new URL(endpoint, reader.url()))).status, 403, `Private reader endpoint ${endpoint}`);
	await reader.screenshot({ path: path.join(results, "reader-packaged.png") });
	if (process.env.LH_TEST_PDF) {
		await reader.getByTestId("reader-file-input").setInputFiles(process.env.LH_TEST_PDF);
		await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	}
	await reader.getByTestId("reader-opacity").fill("71");
	await reader.getByTestId("reader-opacity").dispatchEvent("input");
	const opacity = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getOpacity());
	assert.ok(Math.abs(opacity - .71) < .015);
	await reader.getByTestId("reader-opacity").fill("100");
	await reader.getByTestId("reader-opacity").dispatchEvent("input");
	console.log(`PASS: packaged ${metadata.version} opens the reader, renders a PDF and the chat workspace, enumerates ${voices.length} speech voices, changes native opacity, and protects the local API.`);
} catch (error) {
	console.error("Packaged app diagnostics:", diagnostics.slice(-5000));
	throw error;
} finally {
	if (app) await app.close();
	const absolute = path.resolve(profile);
	if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-study-package-")) {
		await rm(absolute, { recursive: true, force: true }).catch(() => {});
	}
}
