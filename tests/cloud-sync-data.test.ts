import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { applySyncRecord, captureSyncRecords, hashSyncPayload, listSyncPdfs, preserveSyncConflict, readSyncPdf, stableSyncJson, writeSyncPdf, type LocalSyncRecord } from "../src/server/cloud-sync-data.ts";
import { createReaderStore } from "../src/store/reader-sessions.ts";
import { createReaderStudyStore } from "../src/store/reader-studies.ts";

function directory(t: { after(fn: () => void): void }): string {
	const prefix = path.join(os.tmpdir(), "veil-cloud-data-"), result = fs.mkdtempSync(prefix);
	t.after(() => { if (!path.resolve(result).startsWith(prefix)) throw new Error("Unexpected cleanup directory."); fs.rmSync(result, { recursive: true, force: true }); }); return result;
}
function put(root: string, relative: string, value: unknown) {
	const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value));
}
const date = "2026-11-05T08:00:00.000Z";
const chat = { id: "chat_one", title: "Study Linux", createdAt: date, updatedAt: date, messages: [{ role: "user", content: "Explain modules", timestamp: 1 }], tree: { goal: "Learn Linux", nodes: [] }, version: 1 };
const state = { pageCount: 3, page: 2, scrollFraction: .4, scale: 1, fit: true, voice: "English · LJ (neural)", rate: 0, language: "en" as const, chapter: { start: 1, end: 3 }, drafts: { "2": "A kernel module adds a feature." } };
const study = { id: "chat_one", title: "Study Linux", documentName: "Linux.pdf", page: 2, quote: "Modules add functionality.", mode: "teach" as const, createdAt: date, state: "working" as const };
const node = { id: "n_one", name: "Module", statement: "A module extends the kernel.", aliases: [], provenance: [{ chatId: "chat_one", messageId: "m_1" }], createdAt: date };

test("captures the explicit session/progress allow-list, never local secrets or runtime files", t => {
	const root = directory(t); put(root, "chats/chat_one.json", { ...chat, busy: true, apiKey: "must-not-upload", settings: { apiKey: "must-not-upload", model: { provider: "test", id: "model", token: "must-not-upload" } } });
	for (const file of ["auth.json", "settings.json", "cloud-sync/auth.json", "cloud-sync/state.json", "reader/neural/voice.json", "jobs/job_one.json", "debug/log.json"])
		put(root, file, { secret: "must-not-upload" });
	const records = captureSyncRecords(root);
	assert.equal(records.length, 1); assert.equal(records[0]?.key, "chat/chat_one");
	assert.deepEqual(records[0]?.payload, { ...chat, settings: { model: { provider: "test", id: "model" } } }); assert.doesNotMatch(JSON.stringify(records), /must-not-upload|busy/);
	assert.equal(hashSyncPayload({ b: 2, a: 1 }), hashSyncPayload({ a: 1, b: 2 }));
});

test("restores reader content, position, drafts and completed feedback onto another data directory", t => {
	const source = directory(t), target = directory(t), bytes = Buffer.from("%PDF-1.4\nA local PDF.");
	const store = createReaderStore(path.join(source, "reader")), session = store.create("Linux.pdf", bytes, state);
	store.attempt(session.id, { id: "attempt_one", page: 2, chapter: state.chapter, rephrase: state.drafts["2"], language: "en", status: "complete", createdAt: date, updatedAt: date });
	const record = captureSyncRecords(source)[0]!;
	writeSyncPdf(target, session.documentId, readSyncPdf(source, session.documentId)); applySyncRecord(target, record);
	const resumed = createReaderStore(path.join(target, "reader"));
	assert.equal(resumed.get(session.id).page, 2); assert.deepEqual(resumed.get(session.id).drafts, state.drafts);
	assert.equal(resumed.get(session.id).attempts[0]?.status, "complete"); assert.deepEqual(resumed.pdf(session.id), bytes);
	assert.deepEqual(listSyncPdfs(target), [{ hash: session.documentId, bytes: bytes.length }]);
});

test("rejects arbitrary keys, mismatched IDs and PDF bodies before changing local files", t => {
	const root = directory(t); put(root, "auth.json", { protected: true });
	for (const key of ["chat/../auth", "chat/../../auth", "chat/auth.json", "chat/C:\\auth", "auth/auth"])
		assert.throws(() => applySyncRecord(root, { key, kind: "chat", payload: chat }), /key/);
	assert.throws(() => applySyncRecord(root, { key: "chat/chat_other", kind: "chat", payload: chat }), /damaged/);
	assert.throws(() => applySyncRecord(root, { key: "auth.json", kind: "auth", payload: { protected: false } }), /Unknown/);
	const bytes = Buffer.from("%PDF-1.4\nPDF"), hash = createHash("sha256").update(bytes).digest("hex");
	assert.throws(() => writeSyncPdf(root, hash, Buffer.from("wrong")), /invalid/);
	assert.throws(() => readSyncPdf(root, "../auth"), /identity/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "auth.json"), "utf8")), { protected: true });
});

test("refuses file symlinks and junctions escaping the data directory", t => {
	const root = directory(t), outside = directory(t); put(outside, "chat_one.json", chat);
	try { fs.symlinkSync(outside, path.join(root, "chats"), process.platform === "win32" ? "junction" : "dir"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Symlinks unavailable on this host."); return; } throw error; }
	assert.throws(() => captureSyncRecords(root), /outside/);
	assert.throws(() => applySyncRecord(root, { key: "chat/chat_one", kind: "chat", payload: chat }), /outside/);
});

test("graph imports retain source chronology, deduplicate rows and tombstone only the selected assertion", t => {
	const source = directory(t), target = directory(t), later = { ...node, statement: "Modules can be loaded at runtime.", createdAt: "2026-11-05T09:00:00.000Z" };
	fs.mkdirSync(path.join(source, "graph")); fs.writeFileSync(path.join(source, "graph", "nodes.jsonl"), `${JSON.stringify(node)}\n${JSON.stringify(later)}\n`);
	const captured = captureSyncRecords(source); const lines = captured.filter(record => record.kind === "graph-line");
	assert.equal(lines.length, 2);
	for (const record of [...lines].reverse()) applySyncRecord(target, record);
	applySyncRecord(target, lines[0]!);
	const restored = fs.readFileSync(path.join(target, "graph", "nodes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(restored, [node, later]);
	applySyncRecord(target, { ...lines[0]!, tombstone: true, payload: null });
	assert.deepEqual(captureSyncRecords(target).filter(record => record.kind === "graph-line").map(record => record.payload.record), [later]);
	assert.throws(() => applySyncRecord(target, { ...lines[1]!, payload: { ledger: "nodes", record: node } }), /identity/);
});

test("newer schemas and damaged local records stop capture instead of becoming cloud deletions", t => {
	const root = directory(t); put(root, "chats/chat_one.json", { ...chat, version: 999 });
	assert.throws(() => captureSyncRecords(root), /Unsupported/);
	fs.unlinkSync(path.join(root, "chats", "chat_one.json")); put(root, "graph/format.json", { version: 999 });
	assert.throws(() => captureSyncRecords(root), /unsupported format/);
	assert.throws(() => applySyncRecord(root, { key: "graph-format/version", kind: "graph-format", payload: { version: 999 } }), /newer app/);
});

test("conflict copies are visible, preserve both versions and are deterministic across retries", t => {
	const root = directory(t), record: LocalSyncRecord = { key: "chat/chat_one", kind: "chat", payload: chat };
	applySyncRecord(root, record);
	const copy = preserveSyncConflict(root, record, "Laptop");
	assert.notEqual(copy.key, record.key); assert.match(String(copy.payload.title), /conflict copy/);
	assert.deepEqual(preserveSyncConflict(root, record, "Laptop"), copy);
	applySyncRecord(root, { ...record, payload: { ...chat, title: "Desktop change" } });
	const captured = captureSyncRecords(root); assert.equal(captured.length, 2);
	assert.equal(captured.find(value => value.key === record.key)?.payload.title, "Desktop change");
	assert.deepEqual(captured.find(value => value.key === copy.key)?.payload.messages, chat.messages);
	const metadata: LocalSyncRecord = { key: "graph-source/src_one", kind: "graph-source", payload: { id: "src_one", filePath: "Notes.md", importedAt: date } };
	const preserved = preserveSyncConflict(root, metadata, "Laptop"); assert.equal(preserved.kind, "conflict");
	assert.deepEqual(preserveSyncConflict(root, metadata, "Laptop"), preserved);
	assert.equal(captureSyncRecords(root).filter(value => value.kind === "conflict").length, 1);
});

test("durable reader passage links migrate from browser data and restore without live status", t => {
	const source = directory(t), target = directory(t), store = createReaderStudyStore(source);
	assert.equal(store.merge([study])[0]?.state, "ready");
	const record = captureSyncRecords(source).find(value => value.kind === "reader-study")!;
	assert.equal(record.payload.state, "ready"); applySyncRecord(target, record);
	assert.deepEqual(createReaderStudyStore(target).list(), [{ ...study, state: "ready" }]);
	assert.throws(() => store.merge([{ ...study, id: "../../auth" }]), /invalid/);
	assert.equal(stableSyncJson(captureSyncRecords(target)), stableSyncJson([record]));
});
