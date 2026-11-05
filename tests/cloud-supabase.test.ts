import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createCloudAuth } from "../src/server/cloud-auth.ts";
import { cloudProjectConfig, createSupabaseClient, CloudConflictError, CloudSyncError, type CloudConnection } from "../src/server/cloud-supabase.ts";
import { CLOUD_SYNC_SQL } from "../src/server/cloud-sync-schema.ts";

const config = { projectUrl: "https://veil-example.supabase.co", publishableKey: "sb_publishable_test_0123456789" };
const connection: CloudConnection = { ...config, userId: "11111111-1111-4111-8111-111111111111", accessToken: "private-access-token" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const row = (index: number) => ({ owner_id: connection.userId, key: `chat:${String(index).padStart(5, "0")}`, kind: "chat", revision: 1, payload: { title: "saved" }, tombstone: false, updated_at: "2026-11-05T12:00:00Z" });
const session = (overrides: Record<string, unknown> = {}) => ({ access_token: connection.accessToken, refresh_token: "private-refresh-token", expires_in: 3600, user: { id: connection.userId, email: "learner@example.com" }, ...overrides });
function temporary(t: { after: (fn: () => void) => void }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veil-cloud-test-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}

test("cloud configuration accepts public keys, refuses privilege-bypassing keys and unsafe URL shapes", () => {
	assert.equal(cloudProjectConfig({ ...config, projectUrl: `${config.projectUrl}/` }).projectUrl, config.projectUrl);
	const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
	assert.equal(cloudProjectConfig({ ...config, publishableKey: jwt("anon") }).publishableKey, jwt("anon"));
	for (const key of ["sb_secret_0123456789", jwt("service_role"), "unrecognized-secret"]) assert.throws(() => cloudProjectConfig({ ...config, publishableKey: key }), /publishable|anon/i);
	for (const projectUrl of ["http://example.com", `${config.projectUrl}/rest/v1`, "https://user:pass@example.com", `${config.projectUrl}?key=anything`]) assert.throws(() => cloudProjectConfig({ ...config, projectUrl }));
	assert.equal(cloudProjectConfig({ ...config, projectUrl: "http://127.0.0.1:54321" }).projectUrl, "http://127.0.0.1:54321");
});

test("cloud record listing paginates beyond the Supabase default page and restricts every request to the account", async () => {
	const requests: URL[] = [];
	const client = createSupabaseClient(connection, { fetchImpl: (async (input, init) => {
		const url = new URL(String(input)); requests.push(url);
		assert.equal(url.searchParams.get("owner_id"), `eq.${connection.userId}`);
		assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${connection.accessToken}`);
		assert.equal(init?.redirect, "error");
		assert.ok(!url.href.includes(connection.accessToken));
		const offset = Number(url.searchParams.get("offset"));
		return json(Array.from({ length: Math.min(500, 1207 - offset) }, (_, index) => row(offset + index)));
	}) as typeof fetch });
	const rows = await client.listRecords();
	assert.equal(rows.length, 1207); assert.equal(requests.length, 3); assert.equal(rows.at(-1)?.key, "chat:01206");
});

test("foreign-account records are rejected instead of being installed locally", async () => {
	const client = createSupabaseClient(connection, { fetchImpl: (async () => json([{ ...row(1), owner_id: "another-account" }])) as typeof fetch });
	await assert.rejects(client.listRecords(), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_invalid_record");
});

test("incremental sync lists only metadata and fetches changed records by exact owner-scoped key", async () => {
	const requested: URL[] = [];
	const client = createSupabaseClient(connection, { fetchImpl: (async input => {
		const url = new URL(String(input)); requested.push(url);
		if (!url.searchParams.has("key")) {
			assert.ok(!url.searchParams.get("select")?.split(",").includes("payload"));
			return json([{ ...row(1), payload: "must-not-survive-metadata" }]);
		}
		assert.equal(url.searchParams.get("key"), "eq.chat/saved-session"); assert.equal(url.searchParams.get("owner_id"), `eq.${connection.userId}`); assert.equal(url.searchParams.get("limit"), "1");
		return json([{ ...row(1), key: "chat/saved-session" }]);
	}) as typeof fetch });
	const heads = await client.listRecordHeads(); assert.equal(heads.length, 1); assert.ok(!("payload" in heads[0]!));
	assert.equal((await client.getRecord("chat/saved-session"))?.key, "chat/saved-session"); assert.equal(requested.length, 2);
	const missing = createSupabaseClient(connection, { fetchImpl: (async () => json([])) as typeof fetch }); assert.equal(await missing.getRecord("chat/missing"), null);
});

test("record writes use atomic expected revision and distinguish stale changes from network failure", async () => {
	let body: Record<string, unknown> | undefined;
	const client = createSupabaseClient(connection, { fetchImpl: (async (_input, init) => { body = JSON.parse(String(init?.body)); return json({ code: "40001", message: "sync_revision_conflict" }, 409); }) as typeof fetch });
	await assert.rejects(client.putRecord({ key: "chat:example", kind: "chat", expectedRevision: 7, payload: { messages: [] } }), CloudConflictError);
	assert.equal(body?.p_expected_revision, 7); assert.equal(body?.p_tombstone, false); assert.ok(!("owner_id" in (body ?? {})), "ownership must come from auth.uid(), not input");
	const offline = createSupabaseClient(connection, { fetchImpl: (async () => { throw new TypeError("network unavailable"); }) as typeof fetch });
	await assert.rejects(offline.listRecords(), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_offline");
});

test("missing setup has an actionable error and service responses cannot leak authentication tokens", async () => {
	const missing = createSupabaseClient(connection, { fetchImpl: (async () => json({ code: "PGRST205" }, 404)) as typeof fetch });
	await assert.rejects(missing.testConnection(), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_setup_required" && /SQL Editor/.test(error.message));
	const leaking = createSupabaseClient(connection, { fetchImpl: (async () => json({ message: `error ${connection.accessToken} ${config.publishableKey}` }, 400)) as typeof fetch });
	await assert.rejects(leaking.listRecords(), (error: unknown) => error instanceof Error && !error.message.includes(connection.accessToken) && !error.message.includes(config.publishableKey));
});

test("PDF transfers use the account/hash path and reject corrupt content before and after transfer", async () => {
	const bytes = new TextEncoder().encode("%PDF-1.7\nexample");
	const hash = createHash("sha256").update(bytes).digest("hex"); let calls = 0;
	const client = createSupabaseClient(connection, { fetchImpl: (async (input, init) => {
		calls++; assert.equal(new URL(String(input)).pathname, `/storage/v1/object/${init?.method === "POST" ? "" : "authenticated/"}veil-pdfs/${connection.userId}/${hash}.pdf`);
		if (init?.method === "POST") { assert.equal(new Headers(init.headers).get("x-upsert"), "true"); return json({}); }
		return new Response(bytes);
	}) as typeof fetch });
	await client.uploadPdf(hash, bytes); assert.deepEqual(await client.downloadPdf(hash), bytes); assert.equal(calls, 2);
	await assert.rejects(client.uploadPdf("0".repeat(64), bytes), /does not match/); assert.equal(calls, 2);
	const corrupt = createSupabaseClient(connection, { fetchImpl: (async () => new Response("different bytes")) as typeof fetch });
	await assert.rejects(corrupt.downloadPdf(hash), /failed verification/);
	const limit = createSupabaseClient(connection, { fetchImpl: (async () => json({ message: "The object exceeded the maximum allowed size" }, 413)) as typeof fetch });
	await assert.rejects(limit.uploadPdf(hash, bytes), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_file_too_large" && /50 MB/.test(error.message));
});

test("PDF download bounds advertised and streamed bytes before buffering untrusted cloud content", async () => {
	const hash = "a".repeat(64); let cancelled = false, reads = 0;
	const declared = createSupabaseClient(connection, { maxPdfBytes: 64, fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { "content-length": "65" } })) as typeof fetch });
	await assert.rejects(declared.downloadPdf(hash), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_file_too_large"); assert.equal(reads, 0); assert.equal(cancelled, true);
	cancelled = false; reads = 0;
	const streamed = createSupabaseClient(connection, { maxPdfBytes: 64, fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }))) as typeof fetch });
	await assert.rejects(streamed.downloadPdf(hash), /100 MB limit/); assert.equal(reads, 3); assert.equal(cancelled, true);
});

test("cloud sign-in persists the session locally without persisting the password or exposing tokens in status", async t => {
	const directory = temporary(t); let passwordSent = false;
	const fetchImpl = (async (_input, init) => { const sent = JSON.parse(String(init?.body)); passwordSent = sent.password === "not-saved-password"; return json(session()); }) as typeof fetch;
	const auth = createCloudAuth({ directory, fetchImpl }); auth.configure(config);
	await auth.signIn("learner@example.com", "not-saved-password"); assert.ok(passwordSent);
	assert.equal(auth.status().authenticated, true);
	const publicStatus = JSON.stringify(auth.status()); assert.ok(!publicStatus.includes(connection.accessToken)); assert.ok(!publicStatus.includes("private-refresh-token")); assert.ok(!publicStatus.includes(config.publishableKey));
	const files = fs.readdirSync(directory).map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("\n"); assert.ok(!files.includes("not-saved-password"));
	const restarted = createCloudAuth({ directory, fetchImpl }); assert.equal((await restarted.connection()).userId, connection.userId);
	auth.configure({ ...config, publishableKey: "" }); assert.equal(auth.status().authenticated, true, "blank key keeps a saved connection");
	assert.throws(() => auth.configure({ projectUrl: "https://another.supabase.co", publishableKey: "" }), /new project/);
});

test("expired sessions refresh once for simultaneous sync requests and rotated tokens survive restart", async t => {
	const directory = temporary(t); let now = 1_000_000, refreshes = 0;
	const fetchImpl = (async input => {
		if (String(input).includes("refresh_token")) { refreshes++; return json(session({ access_token: "rotated-access", refresh_token: "rotated-refresh" })); }
		return json(session({ expires_in: 1 }));
	}) as typeof fetch;
	const auth = createCloudAuth({ directory, fetchImpl, now: () => now }); auth.configure(config); await auth.signIn("learner@example.com", "password"); now += 2000;
	const values = await Promise.all([auth.connection(), auth.connection(), auth.connection()]);
	assert.equal(refreshes, 1); assert.ok(values.every(value => value.accessToken === "rotated-access"));
	const restarted = createCloudAuth({ directory, fetchImpl, now: () => now }); assert.equal((await restarted.connection()).accessToken, "rotated-access");
});

test("offline refresh retains the account for retry but an invalid refresh token requires sign-in", async t => {
	const directory = temporary(t); let now = 1_000_000, mode = "login";
	const auth = createCloudAuth({ directory, now: () => now, fetchImpl: (async () => {
		if (mode === "offline") throw new TypeError("offline");
		if (mode === "invalid") return json({ message: "Invalid Refresh Token" }, 401);
		return json(session({ expires_in: 1 }));
	}) as typeof fetch });
	auth.configure(config); await auth.signIn("learner@example.com", "password"); now += 2000; mode = "offline";
	await assert.rejects(auth.connection(), /Could not reach/); assert.equal(auth.status().authenticated, true);
	mode = "invalid"; await assert.rejects(auth.connection(), /Invalid Refresh Token/); assert.equal(auth.status().authenticated, false);
});

test("a refresh finishing after sign-out cannot recreate the signed-out account", async t => {
	const directory = temporary(t); let now = 1_000_000, release: ((response: Response) => void) | undefined;
	const auth = createCloudAuth({ directory, now: () => now, fetchImpl: (async input => {
		if (String(input).includes("refresh_token")) return new Promise<Response>(resolve => { release = resolve; });
		if (String(input).includes("logout")) return json({});
		return json(session({ expires_in: 1 }));
	}) as typeof fetch });
	auth.configure(config); await auth.signIn("learner@example.com", "password"); now += 2000;
	const refreshing = auth.connection(); await auth.signOut(); release!(json(session()));
	await assert.rejects(refreshing, /settings changed/); assert.equal(auth.status().authenticated, false); assert.ok(!fs.existsSync(path.join(directory, "session.json")));
});

test("mid-stream interruption keeps refresh credentials and retries successfully instead of signing the learner out", async t => {
	const directory = temporary(t); let now = 1_000_000, interrupted = false;
	const broken = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new TypeError("connection reset while reading")); } }));
	const auth = createCloudAuth({ directory, now: () => now, fetchImpl: (async input => {
		if (String(input).includes("refresh_token") && interrupted) return broken();
		return json(session({ expires_in: 1 }));
	}) as typeof fetch });
	auth.configure(config); await auth.signIn("learner@example.com", "password"); now += 2000; interrupted = true;
	await assert.rejects(auth.connection(), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_offline");
	assert.equal(auth.status().authenticated, true); interrupted = false; assert.equal((await auth.connection()).userId, connection.userId);
	const client = createSupabaseClient(connection, { fetchImpl: (async () => broken()) as typeof fetch });
	await assert.rejects(client.listRecords(), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_offline");
	await assert.rejects(client.downloadPdf("a".repeat(64)), (error: unknown) => error instanceof CloudSyncError && error.code === "cloud_offline");
});

test("sign-up supports email confirmation and setup SQL is packaged identically with owner-only CAS writes", async t => {
	const auth = createCloudAuth({ directory: temporary(t), fetchImpl: (async () => json({ user: { id: connection.userId } })) as typeof fetch });
	auth.configure(config); const result = await auth.signUp("learner@example.com", "password"); assert.equal(result.confirmationRequired, true); assert.equal(result.status.authenticated, false);
	const diskSql = fs.readFileSync(new URL("../supabase/cloud-sync.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n");
	assert.equal(CLOUD_SYNC_SQL, diskSql);
	assert.match(CLOUD_SYNC_SQL, /enable row level security/i); assert.match(CLOUD_SYNC_SQL, /v_owner uuid := auth.uid\(\)/); assert.match(CLOUD_SYNC_SQL, /r.revision = p_expected_revision/); assert.match(CLOUD_SYNC_SQL, /set search_path = ''/);
	assert.match(CLOUD_SYNC_SQL, /revoke all on table public.veil_sync_records from anon, authenticated/);
	assert.match(CLOUD_SYNC_SQL, /'veil-pdfs', 'veil-pdfs', false/);
});
