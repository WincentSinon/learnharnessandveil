export type ReaderLanguage = "en" | "sv";
export interface ReaderChapter { start: number; end: number; title?: string }
export interface ReaderCheckPoint { text: string; pages: number[] }
export interface ReaderCheckResult {
	summary: string; accurate: ReaderCheckPoint[]; missing: ReaderCheckPoint[]; corrections: ReaderCheckPoint[]; followUpQuestion: string;
}
export interface ReaderAttempt {
	id: string; page: number; chapter: ReaderChapter; rephrase: string; language: ReaderLanguage;
	status: "pending" | "complete" | "error"; result?: ReaderCheckResult; error?: string; createdAt: string; updatedAt: string;
	usage?: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>;
}
export interface ReaderSessionState {
	pageCount: number; page: number; scrollFraction: number; scale: number; fit: boolean;
	voice: string; rate: number; language: ReaderLanguage; chapter: ReaderChapter; drafts: Record<string, string>;
}
export interface ReaderSession extends ReaderSessionState {
	version: 1; id: string; documentId: string; documentName: string; createdAt: string; updatedAt: string; attempts: ReaderAttempt[];
}
export type ReaderSessionSummary = Pick<ReaderSession, "id" | "documentName" | "pageCount" | "page" | "updatedAt">;
export function readerId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid reading session.");
	return value;
}
export function chapterRange(value: unknown, pageCount: number): ReaderChapter {
	const chapter = value as ReaderChapter;
	if (!chapter || !Number.isInteger(chapter.start) || !Number.isInteger(chapter.end) || chapter.start < 1 || chapter.end > pageCount || chapter.end < chapter.start) throw new Error("Choose a valid chapter page range.");
	return { start: chapter.start, end: chapter.end, ...(typeof chapter.title === "string" ? { title: chapter.title.slice(0, 200) } : {}) };
}
export function readingState(input: unknown, pageCount?: number): ReaderSessionState {
	const value = input as ReaderSessionState;
	const count = pageCount ?? value?.pageCount;
	if (!value || !Number.isInteger(count) || count < 1 || count > 20_000) throw new Error("Invalid PDF page count.");
	if (!Number.isInteger(value.page) || value.page < 1 || value.page > count) throw new Error("Invalid reading page.");
	if (!Number.isFinite(value.scrollFraction) || value.scrollFraction < -1 || value.scrollFraction > 2 || !Number.isFinite(value.scale) || value.scale < 0.25 || value.scale > 3) throw new Error("Invalid reading position.");
	if (typeof value.fit !== "boolean" || typeof value.voice !== "string" || value.voice.length > 256 || !Number.isInteger(value.rate) || value.rate < -10 || value.rate > 10 || !["en", "sv"].includes(value.language)) throw new Error("Invalid reading preferences.");
	const drafts: Record<string, string> = {};
	if (!value.drafts || typeof value.drafts !== "object" || Array.isArray(value.drafts) || Object.keys(value.drafts).length > 500) throw new Error("Invalid reading drafts.");
	let total = 0;
	for (const [page, text] of Object.entries(value.drafts)) {
		if (!/^\d+$/.test(page) || Number(page) < 1 || Number(page) > count || typeof text !== "string" || text.length > 6000 || (total += text.length) > 1_000_000) throw new Error("Reading drafts are too large.");
		drafts[page] = text;
	}
	return { pageCount: count, page: value.page, scrollFraction: value.scrollFraction, scale: value.scale, fit: value.fit, voice: value.voice, rate: value.rate, language: value.language, chapter: chapterRange(value.chapter, count), drafts };
}
