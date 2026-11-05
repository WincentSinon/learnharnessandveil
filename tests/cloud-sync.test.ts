import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { createCloudSync } from "../src/server/cloud-sync.ts";
import { createCloudAuth } from "../src/server/cloud-auth.ts";
import { CloudConflictError, CloudSyncError, type CloudConnection, type CloudPutRecord, type CloudSyncRecord } from "../src/server/cloud-supabase.ts";
import { applySyncRecord, captureSyncRecords, readSyncPdf } from "../src/server/cloud-sync-data.ts";
import { createReaderStore } from "../src/store/reader-sessions.ts";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
const pdf = new Uint8Array(Buffer.from("%PDF-1.7\nfixture study document\n%%EOF"));
const pdfHash = createHash("sha256").update(pdf).digest("hex");
const timestamp = "2026-11-05T12:00:00.000Z";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

class FakeCloud {
	readonly rows = new Map<string, CloudSyncRecord>();
	readonly pdfs = new Map<string, Uint8Array>();
	offline = false;
	uploads = 0;
	metadataOnly = false;
	headReads = 0;
	listReads = 0;
	recordReads: string[] = [];
	writes: CloudPutRecord[] = [];
	beforePut?: (input: CloudPutRecord, connection: CloudConnection) => Promise<void>;
	beforeList?: (connection: CloudConnection) => Promise<void>;
	beforeDownload?: (hash: string, connection: CloudConnection) => Promise<void>;
	key(owner: string, key: string) { return `${owner}:${key}`; }
	row(owner: string, key: string) { return this.rows.get(this.key(owner, key)); }
	client = (connection: CloudConnection) => ({
		testConnection: async () => { this.check(); },
		...(this.metadataOnly ? {
			listRecordHeads: async () => {
				this.check(); this.headReads++; await this.beforeList?.(connection); this.check();
				return [...this.rows.values()].filter(row => row.owner_id === connection.userId).map(row => ({ owner_id: row.owner_id, key: row.key, kind: row.kind, revision: row.revision, tombstone: row.tombstone, updated_at: row.updated_at }));
			},
			getRecord: async (key: string) => { this.check(); this.recordReads.push(key); const row = this.row(connection.userId, key); return row ? structuredClone(row) : null; },
		} : {}),
		listRecords: async () => {
			this.check(); this.listReads++; await this.beforeList?.(connection); this.check();
			return structuredClone([...this.rows.values()].filter(row => row.owner_id === connection.userId));
		},
		putRecord: async (input: CloudPutRecord) => {
			this.check(); this.writes.push(structuredClone(input)); await this.beforePut?.(input, connection); this.check();
			const previous = this.row(connection.userId, input.key);
			if ((previous?.revision ?? 0) !== input.expectedRevision) throw new CloudConflictError();
			const row: CloudSyncRecord = { owner_id: connection.userId, key: input.key, kind: input.kind, payload: structuredClone(input.payload), tombstone: input.tombstone ?? false, revision: (previous?.revision ?? 0) + 1, updated_at: timestamp };
			this.rows.set(this.key(connection.userId, input.key), row); return structuredClone(row);
		},
		uploadPdf: async (hash: string, bytes: Uint8Array) => { this.check(); this.uploads++; this.pdfs.set(this.key(connection.userId, hash), new Uint8Array(bytes)); },
		downloadPdf: async (hash: string) => {
			this.check(); await this.beforeDownload?.(hash, connection); this.check();
			const bytes = this.pdfs.get(this.key(connection.userId, hash)); assert.ok(bytes, "cloud PDF missing"); return new Uint8Array(bytes);
		},
	});
	private check() { if (this.offline) throw new CloudSyncError("Offline fixture: changes remain local.", "cloud_offline"); }
}

async function device(cloud: FakeCloud, user = "learner", busy: (id: string) => boolean = () => false) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veil-cloud-engine-")); roots.push(directory);
	let activeUser = user;
	const auth = createCloudAuth({ directory: path.join(directory, "cloud-sync"), fetchImpl: async (_url, init) => {
		const body = init?.body ? JSON.parse(String(init.body)) as { email?: string } : {};
		if (body.email) activeUser = body.email.split("@")[0]!;
		return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, user: { id: activeUser, email: `${activeUser}@example.invalid` } });
	} });
	auth.configure({ projectUrl: "https://fixture.supabase.co", publishableKey: "sb_publishable_fixturevalidkey" });
	await auth.signIn(`${user}@example.invalid`, "fixture password");
	const sync = createCloudSync({ directory, auth, client: cloud.client, busy, now: () => Date.parse(timestamp) });
	cleanups.push(sync.stop);
	return { directory, auth, sync, enable: async () => { await sync.action({ action: "enable", enabled: true }); await sync.syncNow(); } };
}
type Device = Awaited<ReturnType<typeof device>>;

function writeChat(target: Device, text: string, id = "chat_lesson") {
	applySyncRecord(target.directory, { key: `chat/${id}`, kind: "chat", payload: { id, title: text, createdAt: timestamp, updatedAt: timestamp, version: 1, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) }] } });
}
function chat(target: Device, id = "chat_lesson") { return JSON.parse(fs.readFileSync(path.join(target.directory, "chats", `${id}.json`), "utf8")) as { title: string; messages: unknown[] }; }
const chatFile = (target: Device) => path.join(target.directory, "chats", "chat_lesson.json");
function chatCopies(target: Device) { return captureSyncRecords(target.directory).filter(record => record.kind === "chat" && record.key !== "chat/chat_lesson"); }

afterEach(() => {
	for (const stop of cleanups.splice(0)) stop();
	for (const directory of roots.splice(0)) {
		assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
		assert.ok(path.basename(directory).startsWith("veil-cloud-engine-"));
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("two devices sync completed chats, saved reading progress and verified PDFs", async () => {
	const cloud = new FakeCloud(), desktop = await device(cloud), laptop = await device(cloud);
	writeChat(desktop, "Explain Linux kernels");
	const store = createReaderStore(path.join(desktop.directory, "reader"));
	const reading = store.create("Lab 1.pdf", pdf, { pageCount: 5, page: 3, scrollFraction: 0.4, scale: 1, fit: true, voice: "en-lj", rate: 0, language: "en", chapter: { start: 2, end: 4 }, drafts: { "3": "The kernel controls hardware through drivers." } });
	await desktop.enable(); await laptop.enable();
	assert.deepEqual(chat(laptop), chat(desktop));
	assert.deepEqual(createReaderStore(path.join(laptop.directory, "reader")).get(reading.id), reading);
	assert.deepEqual(new Uint8Array(readSyncPdf(laptop.directory, pdfHash)), pdf);
	assert.equal(cloud.uploads, 1);
	assert.equal(laptop.sync.status().state, "synced");
	await laptop.sync.syncNow(); assert.equal(cloud.uploads, 1, "unchanged documents must not be uploaded repeatedly");
});

test("offline changes stay intact and retry automatically on a later cycle", async () => {
	const cloud = new FakeCloud(), desktop = await device(cloud); writeChat(desktop, "My offline explanation");
	cloud.offline = true; await desktop.enable();
	assert.equal(desktop.sync.status().state, "offline");
	assert.equal(chat(desktop).title, "My offline explanation"); assert.equal(cloud.rows.size, 0);
	cloud.offline = false; await desktop.sync.syncNow();
	assert.equal(cloud.row("learner", "chat/chat_lesson")?.payload && (cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "My offline explanation");
	assert.equal(desktop.sync.status().state, "synced");
});

test("deleting a previously synced chat propagates a tombstone without resurrection", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	writeChat(a, "Delete this lesson"); await a.enable(); await b.enable();
	fs.unlinkSync(chatFile(a)); await a.sync.syncNow();
	assert.equal(cloud.row("learner", "chat/chat_lesson")?.tombstone, true);
	await b.sync.syncNow(); assert.equal(fs.existsSync(chatFile(b)), false);
	await a.sync.syncNow(); await b.sync.syncNow();
	assert.equal(fs.existsSync(chatFile(a)), false); assert.equal(fs.existsSync(chatFile(b)), false);
});

test("a first-sync collision preserves the complete local conversation before adopting cloud", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	writeChat(a, "Desktop version"); await a.enable(); writeChat(b, "Laptop version");
	await b.enable();
	assert.equal(chat(b).title, "Desktop version");
	const copies = chatCopies(b); assert.equal(copies.length, 1); assert.match(String(copies[0]!.payload.title), /Laptop version/);
	assert.ok(b.sync.status().conflictCount >= 1, "visible preserved chat copies must be counted");
	assert.ok(cloud.row("learner", copies[0]!.key));
});

test("a remote deletion preserves a concurrently edited local conversation as a conflict copy", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	writeChat(a, "Shared version"); await a.enable(); await b.enable();
	writeChat(b, "Laptop work while desktop deletes"); fs.unlinkSync(chatFile(a)); await a.sync.syncNow();
	await b.sync.syncNow();
	assert.equal(fs.existsSync(chatFile(b)), false);
	const copies = chatCopies(b); assert.equal(copies.length, 1); assert.match(String(copies[0]!.payload.title), /Laptop work/);
});

test("a CAS conflict never overwrites a newer remote revision or discards local edits", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	writeChat(a, "Baseline"); await a.enable(); await b.enable();
	writeChat(a, "Desktop concurrent work"); writeChat(b, "Laptop concurrent work");
	const entered = deferred(), release = deferred(); let held = false;
	cloud.beforePut = async input => { if (!held && input.key === "chat/chat_lesson") { held = true; entered.resolve(); await release.promise; } };
	const pendingA = a.sync.syncNow(); await entered.promise;
	await b.sync.syncNow(); release.resolve(); await pendingA;
	assert.equal(chat(a).title, "Desktop concurrent work");
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Laptop concurrent work");
	cloud.beforePut = undefined; await a.sync.syncNow();
	assert.equal(chat(a).title, "Laptop concurrent work");
	assert.ok(chatCopies(a).some(copy => String(copy.payload.title).includes("Desktop concurrent work")));
});

test("editing the current page while its PDF downloads defers the incoming state", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	const storeA = createReaderStore(path.join(a.directory, "reader"));
	const reading = storeA.create("Book.pdf", pdf, { pageCount: 5, page: 1, scrollFraction: 0, scale: 1, fit: true, voice: "en-lj", rate: 0, language: "en", chapter: { start: 1, end: 5 }, drafts: {} });
	await a.enable(); await b.enable();
	storeA.patch(reading.id, { page: 4 }); await a.sync.syncNow();
	fs.unlinkSync(path.join(b.directory, "reader", "documents", `${pdfHash}.pdf`));
	const storeB = createReaderStore(path.join(b.directory, "reader"));
	cloud.beforeDownload = async () => { storeB.patch(reading.id, { page: 2, drafts: { "2": "My new explanation during sync." } }); };
	await b.sync.syncNow();
	assert.equal(storeB.get(reading.id).page, 2); assert.equal(storeB.get(reading.id).drafts["2"], "My new explanation during sync.");
	cloud.beforeDownload = undefined; await b.sync.syncNow();
	assert.equal(storeB.get(reading.id).page, 4);
	assert.ok(captureSyncRecords(b.directory).some(row => row.kind === "reader-session" && row.key !== `reader-session/${reading.id}` && (row.payload.drafts as Record<string, string>)["2"] === "My new explanation during sync."));
});

test("an active local AI turn defers cloud replacement until the turn finishes", async () => {
	let busy = false;
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud, "learner", () => busy);
	writeChat(a, "Baseline"); await a.enable(); await b.enable();
	writeChat(a, "New cloud lesson"); await a.sync.syncNow(); busy = true;
	await b.sync.syncNow(); assert.equal(chat(b).title, "Baseline");
	assert.ok(b.sync.status().pendingCount >= 1);
	busy = false; await b.sync.syncNow(); assert.equal(chat(b).title, "New cloud lesson");
});

test("sign-out fences an in-flight download and a different account starts disabled", async () => {
	const cloud = new FakeCloud(), a = await device(cloud), b = await device(cloud);
	writeChat(a, "Account A private lesson"); await a.enable();
	const entered = deferred(), release = deferred();
	cloud.beforeList = async () => { entered.resolve(); await release.promise; };
	const enabling = b.enable(); await entered.promise;
	const signOut = b.sync.action({ action: "sign-out" }); release.resolve(); await enabling; await signOut;
	assert.equal(fs.existsSync(chatFile(b)), false); assert.equal(b.sync.status().enabled, false); assert.equal(b.sync.status().account, null);
	cloud.beforeList = undefined;
	const other = await device(cloud, "other-learner"); writeChat(other, "Account B lesson"); await other.enable();
	await b.sync.action({ action: "sign-in", email: "other-learner@example.invalid", password: "fixture password" });
	assert.equal(b.sync.status().account?.id, "other-learner"); assert.equal(b.sync.status().enabled, false);
	assert.equal(b.sync.status().lastSyncedAt, null);
	await b.enable(); assert.equal(chat(b).title, "Account B lesson");
	assert.equal(cloud.row("other-learner", "chat/chat_lesson")?.owner_id, "other-learner");
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Account A private lesson");
});

test("edits while an upload awaits stay local, remain pending and upload on the next cycle", async () => {
	const cloud = new FakeCloud(), a = await device(cloud); writeChat(a, "Baseline"); await a.enable();
	writeChat(a, "Snapshot before upload");
	const entered = deferred(), release = deferred();
	cloud.beforePut = async () => { entered.resolve(); await release.promise; };
	const pending = a.sync.syncNow(); await entered.promise;
	writeChat(a, "Latest edit during upload"); release.resolve(); await pending;
	assert.equal(chat(a).title, "Latest edit during upload");
	assert.equal(a.sync.status().state, "idle"); assert.ok(a.sync.status().pendingCount >= 1);
	cloud.beforePut = undefined; await a.sync.syncNow();
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Latest edit during upload");
	assert.equal(a.sync.status().state, "synced");
});

test("a network failure during a record upload is offline and does not acknowledge unsent changes", async () => {
	const cloud = new FakeCloud(), a = await device(cloud); writeChat(a, "Baseline"); await a.enable();
	writeChat(a, "Still only on this laptop");
	cloud.beforePut = async () => { throw new CloudSyncError("Disconnected during upload.", "cloud_offline"); };
	await a.sync.syncNow();
	assert.equal(a.sync.status().state, "offline"); assert.ok(a.sync.status().pendingCount >= 1);
	assert.equal(chat(a).title, "Still only on this laptop");
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Baseline");
	cloud.beforePut = undefined; await a.sync.syncNow();
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Still only on this laptop");
});

test("damaged local files surface a recoverable error without deleting cloud data", async () => {
	const cloud = new FakeCloud(), a = await device(cloud); writeChat(a, "Keep my cloud copy"); await a.enable();
	fs.writeFileSync(chatFile(a), "{unfinished json", "utf8");
	await assert.doesNotReject(() => a.sync.syncNow());
	assert.equal(a.sync.status().state, "error");
	assert.equal(cloud.row("learner", "chat/chat_lesson")?.tombstone, false);
	assert.equal((cloud.row("learner", "chat/chat_lesson")!.payload as { title: string }).title, "Keep my cloud copy");
});

test("metadata polling fetches only changed rows, skips unchanged writes and preserves CAS/deletion kinds", async () => {
	const cloud = new FakeCloud(); cloud.metadataOnly = true;
	const a = await device(cloud), b = await device(cloud);
	writeChat(a, "First lesson"); writeChat(a, "Second lesson", "chat_second");
	await a.enable(); await b.enable();
	assert.equal(cloud.listReads, 0, "the metadata transport must not fall back to complete transcript listings");
	assert.deepEqual(cloud.recordReads.sort(), ["chat/chat_lesson", "chat/chat_second"]);
	cloud.recordReads = []; cloud.writes = []; cloud.headReads = 0;
	await b.sync.syncNow();
	assert.equal(cloud.headReads, 1);
	assert.deepEqual(cloud.recordReads, [], "an unchanged cycle downloads no transcript payloads");
	assert.equal(cloud.writes.length, 0, "an unchanged cycle must not re-upload transcripts or increment revisions");

	writeChat(a, "Updated first lesson"); await a.sync.syncNow();
	assert.deepEqual(cloud.recordReads, []);
	assert.equal(cloud.writes.length, 1); assert.equal(cloud.writes[0]!.key, "chat/chat_lesson"); assert.equal(cloud.writes[0]!.expectedRevision, 1);
	cloud.writes = []; await b.sync.syncNow();
	assert.deepEqual(cloud.recordReads, ["chat/chat_lesson"], "only the changed revision needs a payload fetch");
	assert.equal(cloud.writes.length, 0); assert.equal(chat(b).title, "Updated first lesson");

	cloud.recordReads = []; writeChat(b, "Laptop edit to second lesson", "chat_second"); await b.sync.syncNow();
	assert.deepEqual(cloud.recordReads, []); assert.equal(cloud.writes.length, 1);
	assert.equal(cloud.writes[0]!.key, "chat/chat_second"); assert.equal(cloud.writes[0]!.expectedRevision, 1);
	assert.equal(cloud.row("learner", "chat/chat_second")!.revision, 2);

	cloud.writes = []; fs.unlinkSync(chatFile(b)); await b.sync.syncNow();
	assert.equal(cloud.writes.length, 1); assert.equal(cloud.writes[0]!.kind, "chat");
	assert.equal(cloud.writes[0]!.tombstone, true); assert.equal(cloud.writes[0]!.expectedRevision, 2);
	await a.sync.syncNow(); assert.equal(fs.existsSync(chatFile(a)), false); assert.equal(a.sync.status().state, "synced");
});
