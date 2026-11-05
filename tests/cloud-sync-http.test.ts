import assert from "node:assert/strict";
import { test, after } from "node:test";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Keep these transport checks isolated from the user's real local library.
const previousData = process.env.LH_DATA_DIR, previousServer = process.env.LH_DESKTOP_SERVER, previousSecret = process.env.LH_DESKTOP_API_SECRET;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veil-cloud-http-"));
process.env.LH_DATA_DIR = directory;
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET;
const { cloudSyncResponse, cloudSyncSetupResponse } = await import("../src/server/cloud-sync-http.ts");
after(() => {
	for (const [key, value] of [["LH_DATA_DIR", previousData], ["LH_DESKTOP_SERVER", previousServer], ["LH_DESKTOP_API_SECRET", previousSecret]]) {
		if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
	}
	fs.rmSync(directory, { recursive: true, force: true });
});
function post(headers: Record<string, string> = {}, body: BodyInit = JSON.stringify({ action: "not-an-action" })) {
	return new Request("http://127.0.0.1:3210/api/cloud-sync", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

test("cloud mutations reject missing/null/cross-site origins before touching settings", async () => {
	const attempts: Record<string, string>[] = [{}, { origin: "null" }, { origin: "https://evil.example" }, { origin: "http://127.0.0.1:3210", "sec-fetch-site": "cross-site" }, { origin: "https://evil.example", "x-forwarded-host": "evil.example" }];
	for (const headers of attempts) {
		const response = await cloudSyncResponse(post(headers)); assert.equal(response.status, 403);
	}
	assert.deepEqual(fs.readdirSync(directory), []);
});

test("cloud mutations require JSON and bound streamed/declared input", async () => {
	const origin = "http://127.0.0.1:3210";
	assert.equal((await cloudSyncResponse(post({ origin, "Content-Type": "text/plain" }))).status, 415);
	let reads = 0, cancelled = false;
	const body = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
	const declared = new Request(`${origin}/api/cloud-sync`, { method: "POST", headers: { origin, "Content-Type": "application/json", "Content-Length": "17000" }, body, duplex: "half" } as RequestInit);
	assert.equal((await cloudSyncResponse(declared)).status, 413); assert.equal(reads, 0); assert.equal(cancelled, true);
	const large = post({ origin }, JSON.stringify({ action: "configure", key: "x".repeat(17000) }));
	assert.equal((await cloudSyncResponse(large)).status, 413);
});

test("desktop capability is required even with a forged same-origin header", async () => {
	const secret = "a".repeat(64); process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = secret;
	try {
		assert.equal((await cloudSyncResponse(post({ origin: "http://127.0.0.1:3210" }))).status, 403);
		assert.equal((await cloudSyncResponse(post({ "x-learnharness-desktop": "wrong" }))).status, 403);
		const allowed = await cloudSyncResponse(post({ "x-learnharness-desktop": secret }));
		assert.equal(allowed.status, 400); assert.match((await allowed.json()).error, /Unknown cloud sync action/);
	} finally { delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET; }
});

test("setup SQL is served as non-cacheable text and never includes device authentication", async () => {
	const response = cloudSyncSetupResponse();
	assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8"); assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.match(await response.text(), /create table if not exists public.veil_sync_records/);
});
