import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { isReaderCheckRunning } from "./reader-check.ts";
import { cloudAuth } from "./cloud-auth.ts";
import { createSupabaseClient, CloudConflictError, CloudSyncError, type CloudSyncRecord, type CloudConnection, type CloudRecordHead } from "./cloud-supabase.ts";
import { captureSyncRecords, applySyncRecord, hashSyncPayload, preserveSyncConflict, readSyncPdf, writeSyncPdf, type LocalSyncRecord } from "./cloud-sync-data.ts";

export interface CloudSyncStatus {
	configured: boolean; url: string; keyConfigured: boolean; account: { id: string; email: string } | null;
	enabled: boolean; state: "unconfigured" | "signed-out" | "idle" | "syncing" | "synced" | "offline" | "error";
	lastSyncedAt: string | null; pendingCount: number; conflictCount: number; error: string | null; setupRequired: boolean;
}
interface Checkpoint { revision: number; hash: string | null; kind?: string }
interface SyncState { version: 1; deviceId: string; scope: string; enabled: boolean; entries: Record<string, Checkpoint>; pdfs: string[]; lastSyncedAt: string | null; conflictCount: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const emptyState = (): SyncState => ({ version: 1, deviceId: randomUUID(), scope: "", enabled: false, entries: {}, pdfs: [], lastSyncedAt: null, conflictCount: 0 });
type CloudClient = ReturnType<typeof createSupabaseClient>;
type SyncTransport = Pick<CloudClient, "listRecords" | "putRecord" | "uploadPdf" | "downloadPdf"> & Partial<Pick<CloudClient, "listRecordHeads" | "getRecord">>;

/** Local files remain authoritative offline. Checkpoints are committed after each
 * successful operation, making interrupted cycles and retries idempotent. */
export function createCloudSync(options: {
	directory?: string; auth?: typeof cloudAuth; client?: (connection: CloudConnection) => SyncTransport;
	busy?: (chatId: string) => boolean; notify?: () => void; now?: () => number;
} = {}) {
	const directory = options.directory ?? PATHS.data, file = path.join(directory, "cloud-sync", "state.json");
	const auth = options.auth ?? cloudAuth, makeClient = options.client ?? createSupabaseClient;
	const busy = options.busy ?? isTurnRunning, now = options.now ?? Date.now;
	let state = emptyState();
	try {
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		if (saved.version === 1 && typeof saved.deviceId === "string" && typeof saved.scope === "string" && object(saved.entries) && Array.isArray(saved.pdfs)) state = { ...saved, conflictCount: saved.conflictCount ?? 0 };
	} catch { /* An unconfigured device has no sync bookkeeping yet. */ }
	let phase: CloudSyncStatus["state"] = "idle", error: string | null = null, setupRequired = false;
	let pendingCount = 0, inFlight: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | undefined, generation = 0;
	const fingerprint = (record: LocalSyncRecord | undefined) => record ? hashSyncPayload(record.payload) : null;
	const localRecords = () => new Map(captureSyncRecords(directory).map(record => [record.key, record]));
	function save() {
		fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`;
		try { fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temporary, file); }
		finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
	}
	const scopeFor = (url: string, id: string) => createHash("sha256").update(`${url}\n${id}`).digest("hex");
	function status(inspectLocal = false): CloudSyncStatus {
		const account = auth.status();
		const sameAccount = !!account.userId && state.scope === scopeFor(account.projectUrl, account.userId);
		if (inspectLocal && state.enabled && sameAccount && !inFlight && phase === "synced") {
			try {
				const records = localRecords();
				pendingCount = [...new Set([...records.keys(), ...Object.keys(state.entries)])].filter(key => fingerprint(records.get(key)) !== (state.entries[key]?.hash ?? null)).length;
				if (pendingCount) phase = "idle";
			} catch (failure) {
				phase = "error";
				error = failure instanceof Error ? failure.message : "Local study data could not be read for sync.";
			}
		}
		return {
			configured: account.configured, url: account.projectUrl, keyConfigured: account.keyConfigured,
			account: account.authenticated && account.userId ? { id: account.userId, email: account.email ?? "" } : null,
			enabled: state.enabled && sameAccount,
			state: !account.configured ? "unconfigured" : !account.authenticated ? "signed-out" : phase,
			lastSyncedAt: sameAccount ? state.lastSyncedAt : null, pendingCount,
			conflictCount: state.conflictCount,
			error, setupRequired,
		};
	}
	const notify = () => { options.notify?.(); emit("cloud-sync-changed", {}); };
	const previousEntry = (key: string) => Object.hasOwn(state.entries, key) ? state.entries[key] : undefined;
	function checkpoint(key: string, record: CloudSyncRecord, hash: string | null) { Object.defineProperty(state.entries, key, { value: { revision: record.revision, hash, kind: record.kind }, enumerable: true, configurable: true, writable: true }); save(); }
	function isBusy(record: LocalSyncRecord | CloudSyncRecord | undefined) {
		if (!record || !object(record.payload) || typeof record.payload.id !== "string") return false;
		return record.kind === "chat" ? busy(record.payload.id) : record.kind === "reader-session" && isReaderCheckRunning(record.payload.id);
	}
	async function cycle() {
		if (!status().enabled) return;
		const owner = generation;
		const guard = () => { if (generation !== owner || !state.enabled) throw new CloudSyncError("Cloud settings changed; sync paused.", "cloud_cancelled"); };
		phase = "syncing"; error = null; setupRequired = false; notify();
		try {
			const connection = await auth.connection(); guard();
			if (state.scope !== scopeFor(connection.projectUrl, connection.userId)) throw new CloudSyncError("Sign in and enable sync for this account again.", "cloud_auth_changed");
			const client = makeClient(connection);
			const initial = localRecords();
			pendingCount = new Set([...initial.keys(), ...Object.keys(state.entries)].filter(key => fingerprint(initial.get(key)) !== (state.entries[key]?.hash ?? null))).size;
			// Poll only lightweight revisions. Unchanged transcripts/PDFs never
			// consume the user's cloud bandwidth again on every background cycle.
			const changed: CloudSyncRecord[] = [];
			const headsByKey = new Map<string, CloudRecordHead>();
			if (client.listRecordHeads && client.getRecord) {
				const heads = await client.listRecordHeads(); guard();
				for (const head of heads) {
					headsByKey.set(head.key, head);
					if (previousEntry(head.key)?.revision === head.revision) continue;
					const record = await client.getRecord(head.key); guard();
					if (record) changed.push(record);
				}
			} else changed.push(...await client.listRecords());
			const remote = new Map(changed.map(record => [record.key, record])); guard();
			const locals = localRecords(), keys = new Set([...locals.keys(), ...remote.keys(), ...Object.keys(state.entries)]);
			const uploaded = new Set(state.pdfs), problems: Error[] = [];
			let deferred = 0;
			async function uploadPdf(record: LocalSyncRecord) {
				if (record.kind !== "reader-session" || !object(record.payload) || typeof record.payload.documentId !== "string") return;
				const hash = record.payload.documentId;
				if (!uploaded.has(hash)) { await client.uploadPdf(hash, readSyncPdf(directory, hash)); guard(); uploaded.add(hash); state.pdfs = [...uploaded]; save(); }
			}
			async function downloadPdf(record: CloudSyncRecord) {
				if (record.tombstone || record.kind !== "reader-session" || !object(record.payload) || typeof record.payload.documentId !== "string") return;
				const hash = record.payload.documentId;
				try { readSyncPdf(directory, hash); }
				catch { const bytes = await client.downloadPdf(hash); guard(); writeSyncPdf(directory, hash, bytes); }
			}
			for (const key of [...keys].sort()) {
				guard();
				const local = locals.get(key), cloud = remote.get(key), previous = previousEntry(key);
				const localHash = fingerprint(local), remoteHash = cloud && !cloud.tombstone ? hashSyncPayload(cloud.payload) : null;
				if (isBusy(local) || isBusy(cloud)) { deferred++; continue; }
				try {
					if (cloud && localHash === remoteHash) { checkpoint(key, cloud, localHash); continue; }
					const localChanged = previous ? localHash !== previous.hash : !!local;
					const remoteChanged = previous ? !!cloud && cloud.revision !== previous.revision : !!cloud;
					if (remoteChanged && cloud) {
						await downloadPdf(cloud); guard();
						// A user/AI may have changed a record while its PDF was downloading.
						const fresh = localRecords().get(key);
						if (fingerprint(fresh) !== localHash || isBusy(fresh)) { deferred++; continue; }
						if (localChanged) {
							// A concurrent delete keeps the remote edit and a recovery record of the delete intent.
							const conflict = local ?? { key, kind: "conflict" as const, payload: { deleted: true, sourceKind: cloud.kind } };
							const copy = preserveSyncConflict(directory, conflict, state.deviceId);
							await uploadPdf(copy); guard();
							try { const preserved = await client.putRecord({ ...copy, expectedRevision: state.entries[copy.key]?.revision ?? 0 }); guard(); checkpoint(copy.key, preserved, fingerprint(copy)); }
							catch (failure) { if (!(failure instanceof CloudConflictError)) throw failure; /* Existing identical recovery copy is reconciled next cycle. */ }
						}
						// Recheck after the recovery copy's network write as well.
						if (fingerprint(localRecords().get(key)) !== localHash || isBusy(local)) { deferred++; continue; }
						applySyncRecord(directory, cloud); checkpoint(key, cloud, remoteHash);
						if (cloud.kind === "chat") { emit("chats-changed", {}); if (object(cloud.payload) && typeof cloud.payload.id === "string") emit("record-changed", { chatId: cloud.payload.id }); }
						else if (cloud.kind.startsWith("graph")) emit("sources-changed", {});
					} else if (localChanged) {
						if (local) await uploadPdf(local); guard();
						const written = await client.putRecord({ key, kind: local?.kind ?? cloud?.kind ?? headsByKey.get(key)?.kind ?? previous?.kind ?? "deleted", payload: local?.payload ?? null, tombstone: !local, expectedRevision: cloud?.revision ?? previous?.revision ?? 0 });
						guard(); checkpoint(key, written, localHash);
					}
				} catch (failure) {
					guard();
					if (failure instanceof CloudConflictError) { deferred++; continue; }
					if (failure instanceof CloudSyncError && failure.code === "cloud_setup_required") { setupRequired = true; throw failure; }
					problems.push(failure instanceof Error ? failure : new Error("A record could not sync."));
				}
			}
			guard();
			const latest = localRecords();
			state.conflictCount = [...latest.values()].filter(record => record.kind === "conflict" || /^(chat|reader-session)\/(chat|read)_sync_/.test(record.key)).length;
			pendingCount = new Set([...latest.keys(), ...Object.keys(state.entries)].filter(key => fingerprint(latest.get(key)) !== (state.entries[key]?.hash ?? null))).size + deferred;
			if (problems.length) { pendingCount += problems.length; throw problems[0]!; }
			if (pendingCount) phase = "idle";
			else { phase = "synced"; state.lastSyncedAt = new Date(now()).toISOString(); save(); }
		} catch (failure) {
			if (owner !== generation) return;
			error = failure instanceof Error ? failure.message : "Cloud sync could not finish. Your local saves are unchanged.";
			setupRequired = failure instanceof CloudSyncError && failure.code === "cloud_setup_required";
			phase = failure instanceof CloudSyncError && failure.code === "cloud_offline" ? "offline" : "error";
		} finally { notify(); }
	}
	function syncNow(): Promise<void> {
		if (inFlight) return inFlight;
		inFlight = cycle().finally(() => { inFlight = null; }); return inFlight;
	}
	function start() { if (!timer) { timer = setInterval(() => { if (status().enabled) void syncNow(); }, 10_000); timer.unref?.(); if (status().enabled) void syncNow(); } }
	async function pause() { state.enabled = false; generation++; save(); await inFlight; phase = "idle"; error = null; setupRequired = false; }
	async function action(input: unknown): Promise<{ status: CloudSyncStatus; message?: string }> {
		if (!object(input) || typeof input.action !== "string") throw new CloudSyncError("Choose a cloud sync action.", "cloud_input", 400);
		switch (input.action) {
			case "configure":
				if (typeof input.url !== "string" || typeof input.key !== "string") throw new CloudSyncError("Enter your project URL and publishable key.", "cloud_input", 400);
				await pause(); auth.configure({ projectUrl: input.url, publishableKey: input.key }); break;
			case "sign-in":
			case "sign-up": {
				if (typeof input.email !== "string" || typeof input.password !== "string") throw new CloudSyncError("Enter your cloud account email and password.", "cloud_input", 400);
				await pause();
				if (input.action === "sign-up") { const result = await auth.signUp(input.email, input.password); if (result.confirmationRequired) return { status: status(), message: "Check your email to confirm your account, then sign in here." }; }
				else await auth.signIn(input.email, input.password);
				break;
			}
			case "sign-out": await pause(); await auth.signOut(); break;
			case "enable": {
				if (typeof input.enabled !== "boolean") throw new CloudSyncError("Choose whether automatic sync is enabled.", "cloud_input", 400);
				if (!input.enabled) { await pause(); break; }
				const account = auth.status();
				if (!account.authenticated || !account.userId) throw new CloudSyncError("Sign in before enabling cloud sync.", "cloud_auth_required", 400);
				const scope = scopeFor(account.projectUrl, account.userId);
				if (state.scope !== scope) state = { ...emptyState(), deviceId: state.deviceId, scope };
				state.enabled = true; save(); void syncNow(); break;
			}
			case "sync": if (!status().enabled) throw new CloudSyncError("Enable automatic sync before uploading this device's study data.", "cloud_disabled", 400); void syncNow(); break;
			default: throw new CloudSyncError("Unknown cloud sync action.", "cloud_input", 400);
		}
		notify(); return { status: status() };
	}
	return { status, action, syncNow, start, stop: () => { if (timer) clearInterval(timer); timer = undefined; } };
}

const shared = globalThis as typeof globalThis & { __veilCloudSync?: ReturnType<typeof createCloudSync> };
const service = () => shared.__veilCloudSync ??= createCloudSync();
export function getCloudSyncStatus() { const sync = service(); sync.start(); return sync.status(true); }
export async function cloudSyncAction(body: unknown) { const sync = service(); sync.start(); return sync.action(body); }
