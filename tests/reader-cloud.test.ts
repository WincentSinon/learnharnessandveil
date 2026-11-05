import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { reconcileReaderCloud } from "../src/core/reader-cloud.ts";
import { createReaderStore, readerSessionFingerprint, ReaderSessionConflictError } from "../src/store/reader-sessions.ts";
import { captureSyncRecords, preserveSyncConflict, applySyncRecord, type LocalSyncRecord } from "../src/server/cloud-sync-data.ts";

const base = { pageCount: 5, page: 2, scrollFraction: .4, scale: 1.25, fit: false, voice: "English · LJ (neural)", rate: 1, language: "en" as const, chapter: { start: 1, end: 4 }, drafts: { "2": "Original explanation.", "3": "Another page." } };
function directory(t: { after(fn: () => void): void }): string {
	const prefix = path.join(os.tmpdir(), "veil-reader-cloud-"), root = fs.mkdtempSync(prefix);
	t.after(() => { if (!path.resolve(root).startsWith(prefix)) throw new Error("Unexpected cleanup path."); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}

test("remote drafts merge into an unchanged reader without changing its visible page or narration preferences", () => {
	const remote = { ...base, page: 5, scrollFraction: .9, scale: 2, fit: true, voice: "Svenska · Alma (neural)", rate: 3,
		drafts: { ...base.drafts, "2": "Cloud explanation.", "4": "New remote page." } };
	const result = reconcileReaderCloud(base, base, remote);
	assert.deepEqual(result.state.drafts, remote.drafts); assert.deepEqual(result.conflicts, []); assert.equal(result.localChanges, false);
	assert.equal(result.state.page, 2); assert.equal(result.state.scrollFraction, .4); assert.equal(result.state.voice, base.voice);
	assert.equal(result.state.rate, 1); assert.equal(result.state.scale, 1.25); assert.equal(result.state.fit, false);
});

test("typing on one page and a remote edit on another page are both retained", () => {
	const local = { ...base, drafts: { ...base.drafts, "2": "I am still typing." } };
	const remote = { ...base, drafts: { ...base.drafts, "3": "Remote edit." } };
	const result = reconcileReaderCloud(base, local, remote);
	assert.deepEqual(result.state.drafts, { "2": "I am still typing.", "3": "Remote edit." });
	assert.equal(result.localChanges, true); assert.deepEqual(result.conflicts, []);
	assert.equal(base.drafts["2"], "Original explanation.");
});

test("simultaneous same-page edits preserve local typing and require the remote version to be copied before saving", () => {
	const local = { ...base, drafts: { ...base.drafts, "2": "Typed on laptop." } };
	const remote = { ...base, drafts: { ...base.drafts, "2": "Typed on desktop." } };
	const result = reconcileReaderCloud(base, local, remote);
	assert.deepEqual(result.conflicts, ["draft:2"]); assert.equal(result.state.drafts["2"], "Typed on laptop.");
	assert.equal(remote.drafts["2"], "Typed on desktop."); assert.equal(result.localChanges, true);
	assert.deepEqual(reconcileReaderCloud(base, local, local).conflicts, []);
});

test("remote removals and a locally cleared draft survive reconciliation", () => {
	const remote = { ...base, drafts: { "2": "Original explanation." } };
	const local = { ...base, drafts: { ...base.drafts, "2": "" } };
	const result = reconcileReaderCloud(base, local, remote);
	assert.deepEqual(result.state.drafts, { "2": "" });
});

test("reader saves reject a stale fingerprint even when the remote write has the same timestamp", t => {
	const root = directory(t), store = createReaderStore(path.join(root, "reader"));
	const session = store.create("Book.pdf", Buffer.from("%PDF-1.4\n"), base), fingerprint = readerSessionFingerprint(session);
	const latest = { ...session, drafts: { "2": "Remote change." } };
	applySyncRecord(root, { key: `reader-session/${session.id}`, kind: "reader-session", payload: latest });
	assert.equal(store.get(session.id).updatedAt, session.updatedAt);
	assert.throws(() => store.patch(session.id, { drafts: { "2": "Stale local change." } }, fingerprint), ReaderSessionConflictError);
	assert.equal(store.get(session.id).drafts["2"], "Remote change.");
	const current = store.get(session.id), merged = reconcileReaderCloud(base, { ...base, drafts: { ...base.drafts, "2": "Local work." } }, current);
	const saved = store.patch(session.id, merged.state, readerSessionFingerprint(current));
	assert.equal(saved.drafts["2"], "Local work.");
});

test("editing a visible conflict copy never causes a later retry to overwrite it or lose the original recovery data", t => {
	const root = directory(t), store = createReaderStore(path.join(root, "reader"));
	const session = store.create("Book.pdf", Buffer.from("%PDF-1.4\n"), base);
	const record = captureSyncRecords(root).find(record => record.kind === "reader-session")!;
	const first = preserveSyncConflict(root, record, "Laptop");
	const id = String(first.payload.id); store.patch(id, { drafts: { "2": "Continued studying in the copy." } });
	const second = preserveSyncConflict(root, record, "Laptop");
	assert.notEqual(first.key, second.key);
	assert.equal(store.get(id).drafts["2"], "Continued studying in the copy.");
	assert.deepEqual(second.payload.drafts, session.drafts);
	assert.deepEqual(preserveSyncConflict(root, record, "Laptop"), second);
});

test("edited chat recovery copies and metadata recovery files also remain intact", t => {
	const root = directory(t), date = "2026-11-05T08:00:00.000Z";
	const chat: LocalSyncRecord = { key: "chat/chat_one", kind: "chat", payload: { id: "chat_one", title: "Original", createdAt: date, updatedAt: date, version: 1, messages: [] } };
	const first = preserveSyncConflict(root, chat, "Laptop");
	applySyncRecord(root, { ...first, payload: { ...first.payload, messages: [{ role: "user", content: "More studying", timestamp: 2 }] } });
	const second = preserveSyncConflict(root, chat, "Laptop"); assert.notEqual(second.key, first.key); assert.deepEqual(second.payload.messages, []);
	const metadata: LocalSyncRecord = { key: "graph-source/src_a", kind: "graph-source", payload: { id: "src_a", filePath: "Notes.md", importedAt: date } };
	const saved = preserveSyncConflict(root, metadata, "Laptop");
	applySyncRecord(root, { ...saved, payload: { ...saved.payload, record: { ...metadata.payload, filePath: "Changed.md" } } });
	const another = preserveSyncConflict(root, metadata, "Laptop"); assert.notEqual(another.key, saved.key); assert.deepEqual(another.payload.record, metadata.payload);
});
