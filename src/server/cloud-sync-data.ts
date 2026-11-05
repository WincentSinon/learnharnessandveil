import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts/chat.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";
import { readingState } from "../core/reader-session.ts";
import { parseReaderStudies } from "../core/reader-study.ts";
import { parseSourceOrganization } from "../core/source-organization.ts";

export type SyncRecordKind = "chat" | "reader-session" | "reader-study" | "graph-line" | "graph-source" | "graph-organization" | "graph-format" | "conflict";
export interface LocalSyncRecord { key: string; kind: SyncRecordKind; payload: Record<string, unknown> }
export interface IncomingSyncRecord { key: string; kind: string; payload: unknown; tombstone?: boolean }
export interface SyncPdf { hash: string; bytes: number }

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 24 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const LEDGERS = ["nodes", "chains", "sessions", "coverage"] as const;
type Ledger = typeof LEDGERS[number];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const validDate = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));

/** Canonical fingerprints ignore object insertion order, but retain array/ledger order. */
export function stableSyncJson(value: unknown): string {
	const normalize = (entry: unknown, depth: number): unknown => {
		if (depth > 100) throw new Error("Sync record is nested too deeply.");
		if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
		if (typeof entry === "number" && Number.isFinite(entry)) return entry;
		if (Array.isArray(entry)) return entry.map(item => item === undefined ? null : normalize(item, depth + 1));
		if (object(entry)) return Object.fromEntries(Object.keys(entry).sort().filter(key => entry[key] !== undefined).map(key => [key, normalize(entry[key], depth + 1)]));
		throw new Error("Sync data must contain only JSON values.");
	};
	return JSON.stringify(normalize(value, 0));
}

export function hashSyncPayload(value: unknown): string { return createHash("sha256").update(stableSyncJson(value)).digest("hex"); }

function safePath(directory: string, ...segments: string[]): string {
	const root = path.resolve(directory), target = path.resolve(root, ...segments);
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Invalid sync storage path.");
	// Never follow a user-created symlink/junction out of the selected data directory.
	if (fs.existsSync(root)) {
		const realRoot = fs.realpathSync(root);
		let ancestor = target;
		while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
		const realRelative = path.relative(realRoot, fs.realpathSync(ancestor));
		if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("Sync cannot read or write outside its data directory.");
	}
	return target;
}

function regularFile(directory: string, file: string, maximum = MAX_RECORD_BYTES): Buffer {
	safePath(directory, path.relative(directory, file));
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("Unsupported or oversized local sync file.");
	return fs.readFileSync(file);
}

function readJson(directory: string, file: string): unknown { return JSON.parse(regularFile(directory, file).toString("utf8")); }

function atomicWrite(directory: string, file: string, value: string | Uint8Array): void {
	safePath(directory, path.relative(directory, file));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	safePath(directory, path.relative(directory, file));
	const temporary = `${file}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(temporary, value, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
	finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function writeJson(directory: string, file: string, value: unknown): void { atomicWrite(directory, file, stableSyncJson(value)); }

function listJson(directory: string, segments: string[]): string[] {
	const folder = safePath(directory, ...segments);
	if (!fs.existsSync(folder)) return [];
	return fs.readdirSync(folder).filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5))).sort().map(name => safePath(directory, ...segments, name));
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function chatPayload(value: unknown, id: string): Record<string, unknown> {
	if (!object(value) || value.id !== id || !string(value.title) || !validDate(value.createdAt) || !validDate(value.updatedAt) || !Array.isArray(value.messages)
		|| (value.version !== undefined && value.version !== CURRENT_CHAT_VERSION) || (value.kind !== undefined && value.kind !== "teach" && value.kind !== "practice")) throw new Error("Unsupported or damaged study conversation; sync stopped to preserve it.");
	// An allow-list prevents runtime flags or adjacent credentials from becoming cloud data.
	const clean = pick(value, ["id", "title", "createdAt", "updatedAt", "messages", "kind", "tree", "turns", "extractions", "version"]);
	if (object(value.settings)) {
		const settings = pick(value.settings, ["thinkingLevel"]);
		if (object(value.settings.model)) settings.model = pick(value.settings.model, ["provider", "id"]);
		clean.settings = settings;
	}
	return clean;
}

function readerPayload(value: unknown, id: string): Record<string, unknown> {
	if (!object(value) || value.id !== id || value.version !== 1 || !string(value.documentId) || !HASH.test(value.documentId)
		|| !string(value.documentName) || !validDate(value.createdAt) || !validDate(value.updatedAt) || !Array.isArray(value.attempts)) throw new Error("Unsupported or damaged reading session; sync stopped to preserve it.");
	return { ...readingState(value), ...pick(value, ["id", "version", "documentId", "documentName", "createdAt", "updatedAt", "attempts"]) };
}

function studyPayload(value: unknown, id: string): Record<string, unknown> {
	const parsed = parseReaderStudies(JSON.stringify([value]))[0];
	if (!parsed || parsed.id !== id) throw new Error("Invalid passage-to-session link.");
	// Busy/waiting/error are derived from each device's live session, never synced.
	return { ...pick(parsed as unknown as Record<string, unknown>, ["id", "title", "documentName", "documentId", "page", "quote", "mode", "createdAt"]), state: "ready" };
}

function ledgerRows(directory: string, ledger: Ledger): Record<string, unknown>[] {
	const file = safePath(directory, "graph", `${ledger}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return regularFile(directory, file).toString("utf8").split(/\r?\n/).filter(line => line.trim()).map(line => {
		const row: unknown = JSON.parse(line); validateGraphLine(ledger, row); return row as Record<string, unknown>;
	});
}

function validateGraphLine(ledger: Ledger, value: unknown): asserts value is Record<string, unknown> {
	if (!object(value)) throw new Error("Invalid learning-progress row.");
	const points = (v: unknown) => Array.isArray(v) && v.every(p => object(p) && string(p.chatId) && string(p.messageId));
	const valid = ledger === "nodes"
		? string(value.id) && ID.test(value.id) && string(value.name) && string(value.statement) && Array.isArray(value.aliases) && value.aliases.every(string) && validDate(value.createdAt) && points(value.provenance)
		: ledger === "chains"
			? string(value.id) && ID.test(value.id) && Array.isArray(value.premises) && value.premises.length > 0 && value.premises.every(string) && string(value.conclusion) && points(value.provenance) && validDate(value.createdAt)
			: ledger === "sessions" ? string(value.chatId) && validDate(value.foldedAt)
				: string(value.chatId) && string(value.fp) && Number.isFinite(value.tokens) && validDate(value.foldedAt);
	if (!valid) throw new Error("Invalid or incompatible learning-progress row.");
}

function graphFormat(directory: string): Record<string, unknown> {
	const file = safePath(directory, "graph", "format.json");
	const value = fs.existsSync(file) ? readJson(directory, file) : { version: CURRENT_GRAPH_FORMAT_VERSION };
	if (!object(value) || value.version !== CURRENT_GRAPH_FORMAT_VERSION) throw new Error("Learning progress uses an unsupported format. Update the app before syncing.");
	return { version: CURRENT_GRAPH_FORMAT_VERSION };
}

/** Only explicit session/progress locations participate. No recursive data-folder upload. */
export function captureSyncRecords(directory = PATHS.data): LocalSyncRecord[] {
	const records: LocalSyncRecord[] = [];
	for (const file of listJson(directory, ["chats"])) {
		const id = path.basename(file, ".json"); records.push({ key: `chat/${id}`, kind: "chat", payload: chatPayload(readJson(directory, file), id) });
	}
	for (const file of listJson(directory, ["reader", "sessions"])) {
		const id = path.basename(file, ".json"); records.push({ key: `reader-session/${id}`, kind: "reader-session", payload: readerPayload(readJson(directory, file), id) });
	}
	for (const file of listJson(directory, ["reader", "studies"])) {
		const id = path.basename(file, ".json"); records.push({ key: `reader-study/${id}`, kind: "reader-study", payload: studyPayload(readJson(directory, file), id) });
	}
	for (const file of listJson(directory, ["sync-conflicts"])) {
		const id = path.basename(file, ".json"), value = readJson(directory, file);
		if (!object(value) || !string(value.sourceKey) || !string(value.sourceKind) || !string(value.deviceId) || !object(value.record)) throw new Error("Invalid saved sync conflict.");
		records.push({ key: `conflict/${id}`, kind: "conflict", payload: value });
	}
	const graphDirectory = safePath(directory, "graph");
	if (fs.existsSync(graphDirectory)) {
		records.push({ key: "graph-format/version", kind: "graph-format", payload: graphFormat(directory) });
		for (const ledger of LEDGERS) {
			for (const row of ledgerRows(directory, ledger)) records.push({ key: `graph/${ledger}/${hashSyncPayload(row)}`, kind: "graph-line", payload: { ledger, record: row } });
		}
		const sourcesFile = safePath(directory, "graph", "sources.json");
		if (fs.existsSync(sourcesFile)) {
			const sources = readJson(directory, sourcesFile); if (!object(sources)) throw new Error("Invalid imported-source metadata.");
			for (const [id, source] of Object.entries(sources)) {
				if (!ID.test(id) || !object(source) || source.id !== id || !string(source.filePath) || !validDate(source.importedAt)) throw new Error("Invalid imported-source metadata.");
				records.push({ key: `graph-source/${id}`, kind: "graph-source", payload: pick(source, ["id", "filePath", "importedAt", "contentFp", "extractions"]) });
			}
		}
		const organizationFile = safePath(directory, "graph", "source-organization.json");
		if (fs.existsSync(organizationFile)) records.push({ key: "graph-organization/state", kind: "graph-organization", payload: parseSourceOrganization(readJson(directory, organizationFile)) as unknown as Record<string, unknown> });
	}
	return [...new Map(records.map(record => [record.key, record])).values()];
}

function removeFile(directory: string, file: string): void { safePath(directory, path.relative(directory, file)); if (fs.existsSync(file)) fs.unlinkSync(file); }

/** Call synchronously after rechecking the local fingerprint, with no intervening await. */
export function applySyncRecord(directory: string, incoming: IncomingSyncRecord): void {
	if (!incoming || !string(incoming.key) || !string(incoming.kind)) throw new Error("Invalid cloud record.");
	const deletion = incoming.tombstone === true || incoming.payload === null;
	const segments = incoming.key.split("/");
	const id = segments[1];
	if (incoming.kind === "conflict") {
		if (segments.length !== 2 || segments[0] !== "conflict" || !id || !ID.test(id)) throw new Error("Invalid conflict key.");
		const file = safePath(directory, "sync-conflicts", `${id}.json`);
		if (deletion) { removeFile(directory, file); return; }
		const value = incoming.payload;
		if (!object(value) || !string(value.sourceKey) || !string(value.sourceKind) || !string(value.deviceId) || !object(value.record)
			|| Buffer.byteLength(stableSyncJson(value)) > MAX_RECORD_BYTES) throw new Error("Invalid saved sync conflict.");
		writeJson(directory, file, pick(value, ["sourceKey", "sourceKind", "deviceId", "preservedAt", "record"])); return;
	}
	if (["chat", "reader-session", "reader-study"].includes(incoming.kind)) {
		if (segments.length !== 2 || segments[0] !== incoming.kind || !id || !ID.test(id)) throw new Error("Invalid cloud session key.");
		const locations = incoming.kind === "chat" ? ["chats"] : ["reader", incoming.kind === "reader-session" ? "sessions" : "studies"];
		const file = safePath(directory, ...locations, `${id}.json`);
		if (deletion) { removeFile(directory, file); return; }
		const value = incoming.kind === "chat" ? chatPayload(incoming.payload, id) : incoming.kind === "reader-session" ? readerPayload(incoming.payload, id) : studyPayload(incoming.payload, id);
		if (incoming.kind === "reader-study" && !value.documentId && fs.existsSync(file)) {
			// Older devices can sync passage links without the attachment field.
			const previous = studyPayload(readJson(directory, file), id);
			if (previous.documentId) value.documentId = previous.documentId;
		}
		if (Buffer.byteLength(stableSyncJson(value)) > MAX_RECORD_BYTES) throw new Error("Cloud session is too large.");
		writeJson(directory, file, value); return;
	}
	if (incoming.kind === "graph-line") {
		const ledger = id as Ledger, hash = segments[2];
		if (segments.length !== 3 || segments[0] !== "graph" || !LEDGERS.includes(ledger) || !hash || !HASH.test(hash)) throw new Error("Invalid learning-progress key.");
		graphFormat(directory);
		const rows = ledgerRows(directory, ledger);
		let next = rows.filter(row => hashSyncPayload(row) !== hash);
		if (!deletion) {
			if (!object(incoming.payload) || incoming.payload.ledger !== ledger) throw new Error("Invalid learning-progress payload.");
			validateGraphLine(ledger, incoming.payload.record);
			if (hashSyncPayload(incoming.payload.record) !== hash) throw new Error("Learning-progress identity does not match its contents.");
			next.push(incoming.payload.record);
		}
		// The first node assertion defines its name/statement. Keep chronological
		// source order, rather than network/hash arrival order; preserve known local
		// order for equal timestamps. The content-addressed rows retain all aliases
		// and later same-ID assertions when an earlier line is explicitly deleted.
		if (ledger === "nodes" || ledger === "chains") {
			const originalOrder = new Map(rows.map((row, index) => [hashSyncPayload(row), index]));
			next = next.sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt))
				|| (originalOrder.get(hashSyncPayload(a)) ?? Number.MAX_SAFE_INTEGER) - (originalOrder.get(hashSyncPayload(b)) ?? Number.MAX_SAFE_INTEGER)
				|| hashSyncPayload(a).localeCompare(hashSyncPayload(b)));
		}
		atomicWrite(directory, safePath(directory, "graph", `${ledger}.jsonl`), next.map(row => stableSyncJson(row)).join("\n") + (next.length ? "\n" : ""));
		writeJson(directory, safePath(directory, "graph", "format.json"), { version: CURRENT_GRAPH_FORMAT_VERSION }); return;
	}
	if (incoming.kind === "graph-source") {
		if (segments.length !== 2 || segments[0] !== "graph-source" || !id || !ID.test(id)) throw new Error("Invalid source key.");
		graphFormat(directory);
		const file = safePath(directory, "graph", "sources.json");
		const sources = fs.existsSync(file) ? readJson(directory, file) : {};
		if (!object(sources)) throw new Error("Invalid local source metadata.");
		if (deletion) delete sources[id];
		else {
			const value = incoming.payload;
			if (!object(value) || value.id !== id || !string(value.filePath) || !validDate(value.importedAt)) throw new Error("Invalid cloud source metadata.");
			Object.defineProperty(sources, id, { value: pick(value, ["id", "filePath", "importedAt", "contentFp", "extractions"]), enumerable: true, configurable: true, writable: true });
		}
		writeJson(directory, file, sources); return;
	}
	if (incoming.kind === "graph-organization" && incoming.key === "graph-organization/state") {
		graphFormat(directory); const file = safePath(directory, "graph", "source-organization.json");
		if (deletion) removeFile(directory, file); else writeJson(directory, file, parseSourceOrganization(incoming.payload)); return;
	}
	if (incoming.kind === "graph-format" && incoming.key === "graph-format/version") {
		if (deletion) return; // Never remove format protection while progress exists.
		if (!object(incoming.payload) || incoming.payload.version !== CURRENT_GRAPH_FORMAT_VERSION) throw new Error("Cloud learning progress requires a newer app version.");
		graphFormat(directory); writeJson(directory, safePath(directory, "graph", "format.json"), { version: CURRENT_GRAPH_FORMAT_VERSION }); return;
	}
	throw new Error("Unknown cloud data kind or key; no local files were changed.");
}

/** A conflict becomes a visible saved copy; the original can safely adopt the cloud revision. */
export function preserveSyncConflict(directory: string, record: LocalSyncRecord, deviceId: string): LocalSyncRecord {
	let identity = hashSyncPayload({ key: record.key, payload: record.payload, deviceId }).slice(0, 40);
	const label = deviceId.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 32) || "other device";
	for (let retry = 0; retry < 32; retry++) {
		if (record.kind !== "chat" && record.kind !== "reader-session") {
			const id = `conflict_${identity}`, file = safePath(directory, "sync-conflicts", `${id}.json`);
			if (fs.existsSync(file)) {
				const existing = readJson(directory, file) as Record<string, unknown>;
				if (existing.sourceKey === record.key && existing.sourceKind === record.kind && existing.deviceId === label && hashSyncPayload(existing.record) === hashSyncPayload(record.payload))
					return { key: `conflict/${id}`, kind: "conflict", payload: existing };
				identity = hashSyncPayload({ identity, editedCopy: existing }).slice(0, 40); continue;
			}
			const copy: LocalSyncRecord = { key: `conflict/${id}`, kind: "conflict", payload: { sourceKey: record.key, sourceKind: record.kind, deviceId: label, preservedAt: new Date().toISOString(), record: record.payload } };
			applySyncRecord(directory, copy); return copy;
		}
		const id = `${record.kind === "chat" ? "chat" : "read"}_sync_${identity}`;
		const file = safePath(directory, ...(record.kind === "chat" ? ["chats"] : ["reader", "sessions"]), `${id}.json`);
		const labelField = record.kind === "chat" ? "title" : "documentName";
		const copiedLabel = `${String(record.payload[labelField]).slice(0, record.kind === "chat" ? 400 : 190)} (conflict copy - ${label})`;
		if (fs.existsSync(file)) {
			const existing = readJson(directory, file) as Record<string, unknown>;
			const normalized = { ...existing, id: record.payload.id, updatedAt: record.payload.updatedAt, [labelField]: record.payload[labelField] };
			if (existing[labelField] === copiedLabel && hashSyncPayload(normalized) === hashSyncPayload(record.payload)) return { key: `${record.kind}/${id}`, kind: record.kind, payload: existing };
			// A learner may have continued studying in the visible recovery copy.
			// Keep that work and choose another deterministic recovery identity.
			identity = hashSyncPayload({ identity, editedCopy: existing }).slice(0, 40); continue;
		}
		const copy: LocalSyncRecord = { key: `${record.kind}/${id}`, kind: record.kind, payload: { ...record.payload, id, updatedAt: new Date().toISOString(), [labelField]: copiedLabel } };
		applySyncRecord(directory, copy); return copy;
	}
	throw new Error("Too many edited conflict copies. Local data was preserved; review recovery copies before syncing again.");
}

export function listSyncPdfs(directory = PATHS.data): SyncPdf[] {
	const folder = safePath(directory, "reader", "documents"); if (!fs.existsSync(folder)) return [];
	return fs.readdirSync(folder).filter(name => name.endsWith(".pdf") && HASH.test(name.slice(0, -4))).sort().map(name => {
		const file = safePath(directory, "reader", "documents", name), stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PDF_BYTES) throw new Error("Unsupported or oversized saved PDF.");
		return { hash: name.slice(0, -4), bytes: stat.size };
	});
}

export function readSyncPdf(directory: string, hash: string): Uint8Array {
	if (!HASH.test(hash)) throw new Error("Invalid PDF identity.");
	const bytes = regularFile(directory, safePath(directory, "reader", "documents", `${hash}.pdf`), MAX_PDF_BYTES);
	validatePdf(hash, bytes); return bytes;
}

function validatePdf(hash: string, bytes: Uint8Array): void {
	if (!HASH.test(hash) || !bytes.length || bytes.length > MAX_PDF_BYTES || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))
		|| createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Downloaded PDF is invalid or does not match its identity.");
}

export function writeSyncPdf(directory: string, hash: string, bytes: Uint8Array): void {
	validatePdf(hash, bytes); atomicWrite(directory, safePath(directory, "reader", "documents", `${hash}.pdf`), bytes);
}
