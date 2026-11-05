import type { ReaderSessionState } from "./reader-session.ts";

/** Merge downloaded content against what the reader last acknowledged. The
 * visible page, scroll, zoom and narration preferences always stay untouched. */
export function reconcileReaderCloud(base: ReaderSessionState, local: ReaderSessionState, remote: ReaderSessionState): {
	state: ReaderSessionState; conflicts: string[]; localChanges: boolean;
} {
	const conflicts: string[] = [];
	let localChanges = false;
	function choose<T>(field: string, before: T, ours: T, theirs: T): T {
		const b = JSON.stringify(before), l = JSON.stringify(ours), r = JSON.stringify(theirs);
		if (l === b) return theirs;
		if (l !== r) { localChanges = true; if (r !== b) conflicts.push(field); }
		return ours;
	}
	const drafts: Record<string, string> = {};
	for (const page of new Set([...Object.keys(base.drafts), ...Object.keys(local.drafts), ...Object.keys(remote.drafts)])) {
		const value = choose(`draft:${page}`, base.drafts[page], local.drafts[page], remote.drafts[page]);
		if (value !== undefined) drafts[page] = value;
	}
	return { state: { ...local, drafts, chapter: choose("chapter", base.chapter, local.chapter, remote.chapter), language: choose("language", base.language, local.language, remote.language) }, conflicts, localChanges };
}
