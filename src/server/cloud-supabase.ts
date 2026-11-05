import { createHash } from "node:crypto";

export interface CloudProjectConfig { projectUrl: string; publishableKey: string }
export interface CloudConnection extends CloudProjectConfig { userId: string; accessToken: string }
export interface CloudSyncRecord {
	owner_id: string; key: string; kind: string; revision: number;
	payload: unknown; tombstone: boolean; updated_at: string;
}
export type CloudRecordHead = Omit<CloudSyncRecord, "payload">;
export interface CloudPutRecord {
	key: string; kind: string; payload: unknown; tombstone?: boolean; expectedRevision: number;
}
export class CloudSyncError extends Error {
	constructor(message: string, public readonly code = "cloud_error", public readonly status = 0) { super(message); this.name = "CloudSyncError"; }
}
export class CloudConflictError extends CloudSyncError {
	constructor() { super("This session changed on another computer. Both versions will be preserved.", "cloud_conflict", 409); this.name = "CloudConflictError"; }
}

/** Only the public application key belongs in desktop settings. RLS uses the signed-in user token. */
export function cloudProjectConfig(value: CloudProjectConfig): CloudProjectConfig {
	if (!value || typeof value.projectUrl !== "string" || value.projectUrl.length > 2048 || typeof value.publishableKey !== "string" || value.publishableKey.length > 8192) throw new CloudSyncError("Enter your Supabase project URL and publishable key.", "cloud_config");
	let url: URL;
	try { url = new URL(value.projectUrl.trim()); } catch { throw new CloudSyncError("Enter your Supabase project URL, for example https://your-project.supabase.co.", "cloud_config"); }
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
		throw new CloudSyncError("Use the Supabase project HTTPS URL without a path, password or query string.", "cloud_config");
	}
	const key = value.publishableKey.trim();
	let accepted = /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key);
	if (key.startsWith("eyJ")) {
		try { const claims = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8")); accepted = claims.role === "anon" && key.split(".").length === 3; } catch { accepted = false; }
	}
	if (!accepted) throw new CloudSyncError("Paste a Supabase publishable key or legacy anon key. Secret and service_role keys must not be used in the app.", "cloud_config");
	return { projectUrl: url.origin, publishableKey: key };
}

export function redactCloudError(message: string, secrets: string[]): string {
	let safe = message;
	for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
	return safe.slice(0, 600);
}

async function errorDetails(response: Response): Promise<{ code: string; message: string }> {
	try {
		const bytes = await readCloudResponseBytes(response, 64 * 1024, "cloud_error_too_large", "The cloud returned an oversized error response.");
		const body = JSON.parse(new TextDecoder().decode(bytes));
		return { code: String(body.code || body.error_code || ""), message: String(body.message || body.msg || body.error_description || body.error || "") };
	} catch { return { code: "", message: "" }; }
}

function recordHead(value: unknown, ownerId: string): CloudRecordHead {
	const row = value as CloudRecordHead;
	if (!row || row.owner_id !== ownerId || typeof row.key !== "string" || !row.key || typeof row.kind !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.tombstone !== "boolean" || typeof row.updated_at !== "string") {
		throw new CloudSyncError("The cloud returned an invalid session record. No local data was replaced.", "cloud_invalid_record");
	}
	return { owner_id: row.owner_id, key: row.key, kind: row.kind, revision: row.revision, tombstone: row.tombstone, updated_at: row.updated_at };
}
function record(value: unknown, ownerId: string): CloudSyncRecord {
	const head = recordHead(value, ownerId), payload = (value as CloudSyncRecord).payload;
	if (Buffer.byteLength(JSON.stringify(payload) ?? "null", "utf8") > 16 * 1024 * 1024) throw new CloudSyncError("A cloud session exceeds the 16 MB record limit. No local data was replaced.", "cloud_invalid_record");
	return { ...head, payload };
}

export async function readCloudResponseBytes(response: Response, limit: number, code: string, message: string): Promise<Uint8Array> {
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body?.cancel(); throw new CloudSyncError(message, code);
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	let size = 0; const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const next = await reader.read(); if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new CloudSyncError(message, code);
			chunks.push(next.value);
		}
	} catch (failure) {
		if (failure instanceof CloudSyncError) throw failure;
		throw new CloudSyncError("The cloud transfer was interrupted. Your local changes are saved and will retry when connected.", "cloud_offline");
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	const result = new Uint8Array(size); let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

export function createSupabaseClient(connection: CloudConnection, options: { fetchImpl?: typeof fetch; maxPdfBytes?: number } = {}) {
	const config = cloudProjectConfig(connection), fetchImpl = options.fetchImpl ?? fetch;
	const pdfLimit = Math.min(100 * 1024 * 1024, options.maxPdfBytes ?? 100 * 1024 * 1024);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(connection.userId) || !connection.accessToken) throw new CloudSyncError("Sign in before syncing.", "cloud_auth_required", 401);
	const headers = { apikey: config.publishableKey, Authorization: `Bearer ${connection.accessToken}` };
	async function request(path: string, init?: RequestInit): Promise<Response> {
		let response: Response;
		try { response = await fetchImpl(`${config.projectUrl}${path}`, { ...init, headers: { ...headers, ...init?.headers }, signal: AbortSignal.timeout(60_000), redirect: "error" }); }
		catch { throw new CloudSyncError("Cloud sync is unavailable. Your changes are saved locally and will retry when connected.", "cloud_offline"); }
		if (response.ok) return response;
		const details = await errorDetails(response);
		if (details.code === "40001" || /sync_revision_conflict/.test(details.message)) throw new CloudConflictError();
		if (["42P01", "PGRST202", "PGRST205"].includes(details.code)) throw new CloudSyncError("Cloud tables are not set up yet. Run the setup SQL in your Supabase SQL Editor, then test the connection again.", "cloud_setup_required", response.status);
		if (response.status === 413 || /maximum allowed size|exceeded.*size|payload too large/i.test(details.message)) throw new CloudSyncError("This PDF exceeds the project's upload limit. Supabase Free allows files up to 50 MB; keep it local or change the project's storage plan/limit.", "cloud_file_too_large", response.status);
		if (response.status === 401) throw new CloudSyncError("Your cloud sign-in expired. Sign in again in Cloud sync settings.", "cloud_auth_required", 401);
		const safe = redactCloudError(details.message, [connection.accessToken, config.publishableKey]);
		throw new CloudSyncError(safe || `Cloud request failed (${response.status}). Your local data is unchanged.`, response.status === 404 ? "cloud_not_found" : "cloud_request_failed", response.status);
	}
	function pdfPath(hash: string) {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new CloudSyncError("Invalid PDF identifier.", "cloud_invalid_pdf");
		return `/storage/v1/object/veil-pdfs/${connection.userId}/${hash}.pdf`;
	}
	async function responseJson(response: Response): Promise<unknown> {
		const bytes = await readCloudResponseBytes(response, 20 * 1024 * 1024, "cloud_response_too_large", "The cloud response exceeds the supported session size. No local data was replaced.");
		try { return JSON.parse(new TextDecoder().decode(bytes)); }
		catch { throw new CloudSyncError("The cloud returned unreadable session data. No local data was replaced.", "cloud_invalid_record"); }
	}
	return {
		async testConnection(): Promise<void> {
			const response = await request(`/rest/v1/veil_sync_records?owner_id=eq.${encodeURIComponent(connection.userId)}&select=key&limit=1`);
			await response.body?.cancel();
		},
		async listRecords(): Promise<CloudSyncRecord[]> {
			const rows: CloudSyncRecord[] = [];
			let offset = 0, pageSize = 500;
			for (;;) {
				const response = await request(`/rest/v1/veil_sync_records?owner_id=eq.${encodeURIComponent(connection.userId)}&select=owner_id,key,kind,revision,payload,tombstone,updated_at&order=key.asc&offset=${offset}&limit=${pageSize}`);
				let page: unknown;
				try { page = await responseJson(response); }
				catch (failure) {
					if (failure instanceof CloudSyncError && failure.code === "cloud_response_too_large" && pageSize > 1) { pageSize = Math.max(1, Math.floor(pageSize / 2)); continue; }
					throw failure;
				}
				if (!Array.isArray(page)) throw new CloudSyncError("Cloud session list could not be read.", "cloud_invalid_record");
				rows.push(...page.map(value => record(value, connection.userId)));
				if (page.length < pageSize) return rows;
				offset += page.length;
			}
		},
		async listRecordHeads(): Promise<CloudRecordHead[]> {
			const rows: CloudRecordHead[] = [];
			for (let offset = 0; ; offset += 500) {
				const response = await request(`/rest/v1/veil_sync_records?owner_id=eq.${encodeURIComponent(connection.userId)}&select=owner_id,key,kind,revision,tombstone,updated_at&order=key.asc&offset=${offset}&limit=500`);
				const page = await responseJson(response);
				if (!Array.isArray(page)) throw new CloudSyncError("Cloud session list could not be read.", "cloud_invalid_record");
				rows.push(...page.map(value => recordHead(value, connection.userId)));
				if (page.length < 500) return rows;
			}
		},
		async getRecord(key: string): Promise<CloudSyncRecord | null> {
			if (!/^[A-Za-z0-9_.:/-]{1,512}$/.test(key)) throw new CloudSyncError("Invalid cloud session identifier.", "cloud_invalid_record");
			const query = new URLSearchParams({ owner_id: `eq.${connection.userId}`, key: `eq.${key}`, select: "owner_id,key,kind,revision,payload,tombstone,updated_at", limit: "1" });
			const page = await responseJson(await request(`/rest/v1/veil_sync_records?${query}`));
			if (!Array.isArray(page) || page.length > 1) throw new CloudSyncError("Cloud session could not be read.", "cloud_invalid_record");
			return page.length ? record(page[0], connection.userId) : null;
		},
		async putRecord(value: CloudPutRecord): Promise<CloudSyncRecord> {
			if (!/^[A-Za-z0-9_.:/-]{1,512}$/.test(value.key) || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.kind) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new CloudSyncError("Invalid cloud change.", "cloud_invalid_record");
			if (Buffer.byteLength(JSON.stringify(value.payload) ?? "null", "utf8") > 16 * 1024 * 1024) throw new CloudSyncError("This session exceeds the 16 MB cloud record limit. It remains saved locally.", "cloud_invalid_record");
			const response = await request("/rest/v1/rpc/veil_sync_put", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_key: value.key, p_kind: value.kind, p_payload: value.payload, p_tombstone: value.tombstone ?? false, p_expected_revision: value.expectedRevision }) });
			return record(await responseJson(response), connection.userId);
		},
		async uploadPdf(hash: string, bytes: Uint8Array): Promise<void> {
			if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== hash || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new CloudSyncError("The saved PDF does not match its identifier. It was not uploaded.", "cloud_invalid_pdf");
			await request(pdfPath(hash), { method: "POST", headers: { "Content-Type": "application/pdf", "x-upsert": "true" }, body: new Uint8Array(bytes) });
		},
		async downloadPdf(hash: string): Promise<Uint8Array> {
			const response = await request(pdfPath(hash).replace("/storage/v1/object/", "/storage/v1/object/authenticated/"));
			const bytes = await readCloudResponseBytes(response, pdfLimit, "cloud_file_too_large", "The downloaded PDF exceeds the app's 100 MB limit. Your local PDF was not replaced.");
			if (createHash("sha256").update(bytes).digest("hex") !== hash || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new CloudSyncError("The downloaded PDF failed verification. Your local PDF was not replaced.", "cloud_invalid_pdf");
			return bytes;
		},
	};
}
