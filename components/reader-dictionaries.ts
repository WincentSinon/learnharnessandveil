import nspell from "nspell";
let dictionary: Promise<(word: string) => boolean> | undefined;
export function speechDictionary() {
	dictionary ??= Promise.all(["en", "sv"].map(async language => {
		const [aff, dic] = await Promise.all(["aff", "dic"].map(async extension => {
			const response = await fetch(`/pdf-assets/${language}.${extension}`);
			if (!response.ok) throw new Error("Word dictionary could not be loaded.");
			return response.text();
		}));
		return nspell({ aff: aff!, dic: dic! });
	})).then(dictionaries => (word: string) => dictionaries.some(value => value.correct(word)))
		.catch(() => (word: string) => ["desktop", "understanding", "administration", "network", "computer"].includes(word.toLowerCase()));
	return dictionary;
}
