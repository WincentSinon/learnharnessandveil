import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { MAX_READER_STUDIES, parseReaderStudies, type ReaderStudyRecord } from "../core/reader-study.ts";

/** Durable passage links, separate from their conversations and derived live status. */
export function createReaderStudyStore(dataDirectory = PATHS.data) {
	const directory = path.join(dataDirectory, "reader", "studies");
	function get(id: string): ReaderStudyRecord | null {
		if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
		try {
			const records = parseReaderStudies(`[${fs.readFileSync(path.join(directory, `${id}.json`), "utf8")}]`);
			return records.length === 1 && records[0]?.id === id ? records[0] : null;
		} catch { return null; }
	}
	function list(): ReaderStudyRecord[] {
		if (!fs.existsSync(directory)) return [];
		return fs.readdirSync(directory).filter(file => /^[A-Za-z0-9_-]{1,100}\.json$/.test(file)).flatMap(file => {
			const record = get(file.slice(0, -5));
			return record ? [record] : [];
		}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_READER_STUDIES);
	}
	function merge(raw: unknown): ReaderStudyRecord[] {
		if (!Array.isArray(raw) || raw.length > MAX_READER_STUDIES) throw new Error("Choose up to 100 valid passage links.");
		const records = parseReaderStudies(JSON.stringify(raw));
		if (records.length !== raw.length) throw new Error("Some passage links are invalid.");
		const merged = records.map(record => {
			const previous = get(record.id)?.documentId;
			if (previous && record.documentId && previous !== record.documentId) throw new Error("This study session already has a different PDF attached.");
			return { ...record, documentId: record.documentId ?? previous };
		});
		fs.mkdirSync(directory, { recursive: true });
		for (const record of merged) {
			const { id, title, documentName, documentId, page, quote, mode, createdAt } = record;
			const target = path.join(directory, `${id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
			try { fs.writeFileSync(temporary, JSON.stringify({ id, title, documentName, documentId, page, quote, mode, createdAt, state: "ready" }), { mode: 0o600 }); fs.renameSync(temporary, target); }
			finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
		}
		return list();
	}
	return { get, list, merge };
}

export const readerStudyStore = createReaderStudyStore();
