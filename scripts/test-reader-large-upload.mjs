import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

// A valid two-page PDF with an unreachable padding stream and a real xref.
// Its multipart upload crosses the old 26 MiB proxy cap without private data.
function largePdf() {
	const padding = Buffer.alloc(32 * 1024 * 1024, 32);
	const pageStream = text => Buffer.from(`BT /F1 16 Tf 60 700 Td (${text}) Tj ET`);
	const first = pageStream("A large local PDF can be saved without truncation.");
	const second = pageStream("A later page survives a complete application restart.");
	const stream = bytes => Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from("\nendstream")]);
	const objects = [
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from("<< /Type /Pages /Count 2 /Kids [4 0 R 6 0 R] >>"),
		Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
		Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"),
		stream(first),
		Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>"),
		stream(second), stream(padding),
	];
	const parts = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [];
	let length = parts[0].length;
	for (const [index, object] of objects.entries()) {
		offsets.push(length);
		const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
		parts.push(part); length += part.length;
	}
	parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
	return Buffer.concat(parts);
}

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const modulePath = process.env.LH_PLAYWRIGHT_MODULE;
const { _electron: electron } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
const profile = await mkdtemp(path.join(os.tmpdir(), "veil-large-upload-"));
const results = path.join(root, "test-results"); await mkdir(results, { recursive: true });
const fixturePath = path.join(profile, "Large local PDF regression.pdf");
const fixture = largePdf(); await writeFile(fixturePath, fixture);
const expectedHash = createHash("sha256").update(fixture).digest("hex");
assert.ok(fixture.length > 32 * 1024 * 1024);
const dev = Boolean(process.env.LH_TEST_URL) && !process.env.LH_TEST_EXECUTABLE;
let app, reader, modelRequests = 0, diagnostics = "";
const rendererErrors = [];
async function launch() {
	app = await electron.launch({
		executablePath: process.env.LH_TEST_EXECUTABLE || (dev ? require("electron") : path.join(root, "dist/win-unpacked/Veil Study.exe")),
		cwd: root, args: [...(dev ? ["."] : []), `--user-data-dir=${profile}`],
		env: { ...process.env, LH_DEV_URL: dev ? process.env.LH_TEST_URL : "", LH_START_READER: "1", NEXT_TELEMETRY_DISABLED: "1" }, timeout: 60000,
	});
	app.process().stdout?.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-12000); });
	app.process().stderr?.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-12000); });
	reader = await app.firstWindow({ timeout: 60000 }); reader.setDefaultTimeout(45000);
	await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false); });
	reader.on("pageerror", error => rendererErrors.push(error.message));
	await reader.waitForURL(/\/reader\/?$/);
	await reader.getByTestId("reader-save").waitFor();
	// Even an unexpected flow cannot make a paid AI request in this test.
	await reader.route("**/api/reader/check**", route => { modelRequests++; return route.fulfill({ status: 500, json: { error: "AI must not run during an upload regression." } }); });
}
try {
	await launch();
	await reader.getByTestId("reader-file-input").setInputFiles(fixturePath);
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	await reader.getByRole("button", { name: "Next PDF page", exact: true }).click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-page"]').value === "2");
	const existingIds = await reader.evaluate(async () => (await (await fetch("/api/reader/sessions")).json()).sessions.map(session => session.id));
	const saving = reader.waitForResponse(response => new URL(response.url()).pathname === "/api/reader/sessions" && response.request().method() === "POST");
	await reader.getByTestId("reader-save").click();
	const saveResponse = await saving;
	assert.equal(saveResponse.status(), 201, await reader.getByRole("alert").allTextContents());
	await reader.getByTestId("reader-save").filter({ hasText: "Saved" }).waitFor();
	// The POST is large enough to evict its DevTools response body from the
	// inspector cache. Read the durable record through the real private API.
	const saved = await reader.evaluate(async previous => {
		const listing = await (await fetch("/api/reader/sessions")).json();
		const created = listing.sessions.find(session => !previous.includes(session.id) && session.documentName === "Large local PDF regression.pdf");
		if (!created) throw new Error("The large upload did not create a new reading session.");
		const response = await fetch(`/api/reader/sessions/${created.id}`);
		if (!response.ok) throw new Error(`Saved session returned ${response.status}`);
		return response.json();
	}, existingIds);
	assert.equal(saved.session.documentId, expectedHash);
	assert.equal(saved.session.page, 2); assert.equal(saved.session.pageCount, 2);
	const roundtrip = await reader.evaluate(async id => {
		const response = await fetch(`/api/reader/sessions/${id}/pdf`);
		if (!response.ok) throw new Error(`Saved PDF request returned ${response.status}`);
		const bytes = await response.arrayBuffer();
		const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
		return { bytes: bytes.byteLength, hash };
	}, saved.session.id);
	assert.deepEqual(roundtrip, { bytes: fixture.length, hash: expectedHash });
	if (!dev) assert.equal((await fetch(new URL(`/api/reader/sessions/${saved.session.id}/pdf`, reader.url()))).status, 403);
	console.log(`PASS: ${fixture.length} PDF bytes cross real ${dev ? "development" : "packaged"} Next proxy, save through normal UI, and roundtrip with identical SHA-256.`);
	await rm(fixturePath); // Resume must use the saved copy, not the import file.
	await app.close(); app = null;
	await launch();
	await reader.getByTestId("reader-library").click();
	await reader.getByTestId("reader-saved-session").filter({ hasText: "Large local PDF regression.pdf" }).first().click();
	await reader.waitForFunction(() => document.querySelector('[data-testid="reader-page"]').value === "2");
	await reader.locator('[data-page="2"][data-rendered="true"] .textLayer span').first().waitFor();
	assert.match(await reader.locator('[data-page="2"] .textLayer').textContent(), /later page survives/);
	console.log(`PASS: the saved large PDF restores page two after ${dev ? "app" : "full app/server"} restart with its original import file removed.`);

	const malformed = await reader.evaluate(async () => {
		const response = await fetch("/api/reader/sessions", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=broken" }, body: "--broken\r\nnot a complete multipart upload" });
		return { status: response.status, body: await response.json() };
	});
	assert.equal(malformed.status, 400); assert.ok(malformed.body.code);
	assert.doesNotMatch(malformed.body.error, /Failed to parse body as FormData|TypeError:/);
	// Open a fresh unsaved file, so understanding checks must attempt a save.
	await reader.getByTestId("reader-file-input").setInputFiles({ name: "Upload error presentation.pdf", mimeType: "application/pdf", buffer: fixture });
	await reader.locator('[data-page="1"][data-rendered="true"] .textLayer span').first().waitFor();
	await reader.route("**/api/reader/sessions", route => route.request().method() === "POST"
		? route.fulfill({ status: 400, json: { error: "Could not read the PDF upload. Please reopen the PDF and try again.", code: "reader_upload_incomplete" } })
		: route.continue());
	await reader.getByTestId("reader-check-open").click();
	const explanation = "This explanation should remain here when the local PDF upload fails.";
	await reader.getByTestId("reader-rephrase").fill(explanation);
	await reader.getByTestId("reader-check-submit").click();
	const alert = reader.getByRole("alert").filter({ hasText: "Could not read the PDF upload" }); await alert.waitFor();
	assert.equal(await alert.getByRole("button", { name: "Model settings", exact: true }).count(), 0);
	assert.equal(await reader.getByTestId("reader-rephrase").inputValue(), explanation);
	assert.equal(modelRequests, 0); assert.deepEqual(rendererErrors, []);
	await reader.screenshot({ path: path.join(results, "reader-upload-error.png") });
	console.log("PASS: malformed multipart yields a safe upload message, retains the rephrase, and offers no misleading Model settings action; no AI request was made.");
} catch (error) {
	console.error("Large-upload diagnostics:", diagnostics.slice(-5000));
	if (reader) await reader.screenshot({ path: path.join(results, "reader-large-upload-failure.png"), timeout: 10000 }).catch(() => {});
	throw error;
} finally {
	if (app) await app.close();
	for (const candidate of [profile, `${profile}-dev`]) {
		const absolute = path.resolve(candidate);
		if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith("veil-large-upload-")) await rm(absolute, { recursive: true, force: true }).catch(() => {});
	}
}
