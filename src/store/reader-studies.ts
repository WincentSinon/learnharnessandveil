import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { MAX_READER_STUDIES, parseReaderStudies, type ReaderStudyRecord } from "../core/reader-study.ts";

/** Durable passage links, separate from their conversations and derived live status. */
export function createReaderStudyStore(dataDirectory = PATHS.data) {
	const directory = path.join(dataDirectory, "reader", "studies");
	function list(): ReaderStudyRecord[] {
		if (!fs.existsSync(directory)) return [];
		return fs.readdirSync(directory).filter(file => /^[A-Za-z0-9_-]{1,100}\.json$/.test(file)).flatMap(file => {
			try { return parseReaderStudies(`[${fs.readFileSync(path.join(directory, file), "utf8")}]`); } catch { return []; }
		}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_READER_STUDIES);
	}
	function merge(raw: unknown): ReaderStudyRecord[] {
		if (!Array.isArray(raw) || raw.length > MAX_READER_STUDIES) throw new Error("Choose up to 100 valid passage links.");
		const records = parseReaderStudies(JSON.stringify(raw));
		if (records.length !== raw.length) throw new Error("Some passage links are invalid.");
		fs.mkdirSync(directory, { recursive: true });
		for (const record of records) {
			const { id, title, documentName, page, quote, mode, createdAt } = record;
			const target = path.join(directory, `${id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
			try { fs.writeFileSync(temporary, JSON.stringify({ id, title, documentName, page, quote, mode, createdAt, state: "ready" }), { mode: 0o600 }); fs.renameSync(temporary, target); }
			finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
		}
		return list();
	}
	return { list, merge };
}

export const readerStudyStore = createReaderStudyStore();
