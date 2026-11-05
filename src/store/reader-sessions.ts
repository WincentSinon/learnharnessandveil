import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { readerId, readingState, type ReaderSession, type ReaderSessionSummary, type ReaderAttempt } from "../core/reader-session.ts";

export function readerSessionFingerprint(session: ReaderSession): string { return createHash("sha256").update(JSON.stringify(session)).digest("hex"); }
export class ReaderSessionConflictError extends Error {
	constructor(readonly session: ReaderSession) { super("This reading session changed on another device. Refreshing before saving your draft."); }
}

export function createReaderStore(directory = path.join(PATHS.data, "reader")) {
	const records = path.join(directory, "sessions"), documents = path.join(directory, "documents");
	const file = (id: string) => path.join(records, `${readerId(id)}.json`);
	function write(session: ReaderSession) {
		fs.mkdirSync(records, { recursive: true });
		const temporary = `${file(session.id)}.${randomUUID()}.tmp`;
		try { fs.writeFileSync(temporary, JSON.stringify(session), { mode: 0o600 }); fs.renameSync(temporary, file(session.id)); }
		finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
	}
	function get(id: string): ReaderSession {
		let session: ReaderSession;
		try { session = JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { throw new Error("Saved reading session could not be found."); }
		if (session.version !== 1 || session.id !== id || !/^[a-f0-9]{64}$/.test(session.documentId) || !Array.isArray(session.attempts)) throw new Error("Unsupported or damaged reading session.");
		readingState(session);
		// A crashed AI job must be retryable after restarting the application.
		return session;
	}
	function list(): ReaderSessionSummary[] {
		if (!fs.existsSync(records)) return [];
		return fs.readdirSync(records).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).flatMap(name => {
			try { const session = get(name.slice(0, -5)); return [{ id: session.id, documentName: session.documentName, page: session.page, pageCount: session.pageCount, updatedAt: session.updatedAt }]; } catch { return []; }
		}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	return {
		get, list,
		create(name: string, bytes: Uint8Array, state: unknown) {
			if (!bytes.length || bytes.length > 100 * 1024 * 1024 || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new Error("Choose a valid PDF smaller than 100 MB.");
			const normalized = readingState(state);
			const documentId = createHash("sha256").update(bytes).digest("hex");
			fs.mkdirSync(documents, { recursive: true });
			const documentPath = path.join(documents, `${documentId}.pdf`);
			if (!fs.existsSync(documentPath)) {
				const temporary = `${documentPath}.${randomUUID()}.tmp`;
				try { fs.writeFileSync(temporary, bytes, { mode: 0o600 }); fs.renameSync(temporary, documentPath); }
				finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
			}
			const now = new Date().toISOString();
			const session: ReaderSession = { ...normalized, version: 1, id: `read_${randomUUID()}`, documentId, documentName: path.basename(name).slice(0, 256) || "Document.pdf", createdAt: now, updatedAt: now, attempts: [] };
			write(session); return session;
		},
		patch(id: string, patch: unknown, expectedFingerprint?: string) {
			const previous = get(id);
			if (expectedFingerprint !== undefined && expectedFingerprint !== readerSessionFingerprint(previous)) throw new ReaderSessionConflictError(previous);
			const session = { ...previous, ...readingState({ ...previous, ...(patch && typeof patch === "object" ? patch : {}) }, previous.pageCount), updatedAt: new Date().toISOString() };
			write(session); return session;
		},
		pdf(id: string) { const session = get(id); return fs.readFileSync(path.join(documents, `${session.documentId}.pdf`)); },
		attempt(id: string, attempt: ReaderAttempt) {
			const session = get(id);
			const existing = session.attempts.findIndex(value => value.id === attempt.id);
			if (existing < 0) session.attempts.push(attempt); else session.attempts[existing] = attempt;
			session.attempts = session.attempts.slice(-200);
			session.updatedAt = new Date().toISOString(); write(session); return attempt;
		},
	};
}
export const readerStore = createReaderStore();
