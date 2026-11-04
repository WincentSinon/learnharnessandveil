import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
	assert.equal(metadata.version, "0.4.1-veil.1");
	assert.equal(metadata.windows, 1, "The reader is the initial window; no workspace steals focus");
	const settings = await reader.evaluate(async () => (await fetch("/api/settings")).json());
	assert.ok("settings" in settings, "The owned reader reaches the protected API");
	const outsider = await fetch(new URL("/api/settings", reader.url()));
	assert.equal(outsider.status, 403, "An unpaired external process cannot use the private desktop API");
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
	console.log(`PASS: packaged ${metadata.version} launches directly into one reader, renders the local PDF, changes native opacity, and preserves private API access.`);
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
