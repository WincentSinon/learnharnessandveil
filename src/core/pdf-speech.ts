export interface SpeechSegment { start: number; end: number; itemIndex: number; sourceStart: number; sourceEnd: number }
export interface PdfSpeech { text: string; segments: SpeechSegment[]; repairs: number }
type Character = { value: string; item: number; from: number; to: number };
const ligatures: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl" };

/** Normalize narration, retaining UTF-16 positions into the actual PDF text runs. */
export function buildPdfSpeech(items: readonly unknown[], isWord: (word: string) => boolean = word => word.toLowerCase() === "desktop"): PdfSpeech {
	const chars: Character[] = [];
	let itemIndex = -1;
	const space = (value: string) => chars.push({ value, item: -1, from: 0, to: 0 });
	for (const item of items) {
		if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") continue;
		itemIndex++;
		if (chars.length && !/\s/.test(chars.at(-1)!.value) && item.str && !/^\s/.test(item.str)) space(" ");
		for (let offset = 0; offset < item.str.length;) {
			const original = String.fromCodePoint(item.str.codePointAt(offset)!);
			const value = ligatures[original] ?? original;
			if (original !== "\u0000") for (const unit of value.split("")) chars.push({ value: unit, item: itemIndex, from: offset, to: offset + original.length });
			offset += original.length;
		}
		if ("hasEOL" in item && item.hasEOL) space("\n");
	}
	const raw = chars.map(char => char.value).join("");
	const removed = new Set<number>();
	let repairs = 0;
	for (const match of raw.matchAll(/\u00ad(?:[ \t]*\n[ \t]*)?/gu)) {
		for (let i = match.index; i < match.index + match[0].length; i++) removed.add(i);
		repairs++;
	}
	for (const match of raw.matchAll(/([\p{L}]+)-[ \t]*\n[ \t]*([\p{Ll}][\p{L}]*)/gu)) {
		const left = match[1]!, right = match[2]!;
		const line = raw.slice(raw.lastIndexOf("\n", match.index - 1) + 1, match.index + match[0].length);
		// Acronyms, suspended compounds and URL/code lines retain their punctuation.
		if (["och", "and", "eller", "or"].includes(right.toLowerCase())) continue;
		// Retain genuine compound hyphens, but remove their wrapping gap.
		for (let i = match.index + left.length + 1; i < match.index + match[0].length - right.length; i++) removed.add(i);
		if (left.length >= 2 && right.length >= 2 && !/^[A-ZÅÄÖ]{2,}$/.test(left) && !/https?:|www\.|[\\/`=]/i.test(line) && isWord(left + right)) { removed.add(match.index + left.length); repairs++; }
	}
	const normalized: Character[] = [];
	for (const [index, char] of chars.entries()) {
		if (removed.has(index)) continue;
		if (/\s/.test(char.value)) {
			if (normalized.length && normalized.at(-1)!.value !== " ") normalized.push({ ...char, value: " " });
		} else normalized.push(char);
	}
	while (normalized.at(-1)?.value === " ") normalized.pop();
	const segments: SpeechSegment[] = [];
	for (const [offset, char] of normalized.entries()) {
		if (char.item < 0) continue;
		const previous = segments.at(-1);
		if (previous && previous.itemIndex === char.item && previous.end === offset && ((previous.end - previous.start === previous.sourceEnd - previous.sourceStart && char.to - char.from === 1 && previous.sourceEnd === char.from) || (previous.sourceStart === char.from && previous.sourceEnd === char.to))) {
			previous.end = offset + 1; previous.sourceEnd = char.to;
		} else segments.push({ start: offset, end: offset + 1, itemIndex: char.item, sourceStart: char.from, sourceEnd: char.to });
	}
	return { text: normalized.map(char => char.value).join(""), segments, repairs };
}
