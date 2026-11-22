// src/core/answer-resolver.ts
/**
 * Resolve a dictated answer to a question (pure; no I/O, no clock).
 *
 * For an option question the transcript is matched, in this order, by:
 *   1. a reference to a letter, ordinal, number word or digit ("la B", "opzione b", "the second",
 *      "numero due", "2");
 *   2. otherwise the label whose tokens best overlap the transcript (Jaccard on content words).
 * A reference beyond the option count resolves to nothing. Two different references are ambiguous,
 * unless a correction word ("no", "anzi", "aspetta", "wait", ...) is present: then the last one wins.
 * A label match needs a score of at least 0.6 and a lead of at least 0.2 over the runner-up.
 * For an open question the transcript itself is the answer (resolveOpen).
 */

export interface ResolvableOption {
	label: string;
	value?: string;
}

export type OptionResolution =
	| { kind: "option"; index: number; value: string }
	| { kind: "ambiguous" }
	| { kind: "none" };

const MATCH_THRESHOLD = 0.6;
const MATCH_MARGIN = 0.2;

const CORRECTION_WORDS = new Set(["no", "anzi", "aspetta", "wait", "actually", "scratch"]);

/** Words that introduce a reference ("la B", "opzione 2", "the second", "numero due"). */
const REFERENCE_PREFIX = new Set([
	"la", "lettera", "letter", "opzione", "option", "risposta", "scelta", "the", "numero", "number",
]);

/** Prefixes that make a bare 'a', 'e', 'i' or 'o' a letter: the article/preposition/conjunction
 *  reading is ruled out. Only these, and only when the token is the whole transcript or follows one. */
const GUARD_PREFIX = new Set(["la", "option", "opzione", "risposta", "letter"]);
const GUARDED_LETTERS = new Set(["a", "e", "i", "o"]);

/** Ordinals and number words. Feminine ordinals only: the masculine "secondo" is "according to" ("secondo me"). */
const ORDINALS = new Map<string, number>([
	["prima", 1], ["seconda", 2], ["terza", 3], ["quarta", 4], ["quinta", 5], ["sesta", 6],
	["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
]);

const CARDINALS = new Map<string, number>([
	["uno", 1], ["una", 1], ["due", 2], ["tre", 3], ["quattro", 4], ["cinque", 5], ["sei", 6],
	["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
]);

const STOPWORDS_IT = [
	"il", "lo", "la", "gli", "le", "di", "che", "e", "è", "un", "una", "per", "con", "non", "sono", "del", "della",
	"dei", "delle", "nel", "nella", "anche", "come", "questo", "questa", "più", "ma", "da", "alla", "dello", "degli",
	"a", "si", "mi", "penso", "credo", "forse", "allora",
];
const STOPWORDS_EN = [
	"the", "and", "of", "to", "is", "are", "that", "with", "for", "this", "it", "as", "by", "from", "an", "be",
	"which", "or", "on", "was", "were", "have", "has", "not", "we", "can",
	"i", "think", "believe", "maybe", "answer",
];

/** Lowercase, accents and apostrophes removed (so "d'accordo" is one word), other punctuation a space, spaces collapsed. */
function normalise(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.replace(/['’`"]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function tokens(text: string): string[] {
	const normalised = normalise(text);
	return normalised.length === 0 ? [] : normalised.split(" ");
}

function stopwordSet(words: string[]): Set<string> {
	return new Set(words.map(normalise));
}

const STOPWORDS: Record<"it" | "en", Set<string>> = {
	it: stopwordSet(STOPWORDS_IT),
	en: stopwordSet(STOPWORDS_EN),
};

/** The content words of a text: tokens minus stopwords (of the given language, or both when unknown). */
function contentWords(text: string, language?: "it" | "en"): Set<string> {
	const stop = language === undefined ? new Set([...STOPWORDS.it, ...STOPWORDS.en]) : STOPWORDS[language];
	return new Set(tokens(text).filter((t) => !stop.has(t)));
}

/** The 0-based option indices named by letter, ordinal, number word or digit, in the order spoken.
 *  Not yet filtered by the option count. */
function referencedIndices(words: string[]): number[] {
	const found: number[] = [];
	words.forEach((word, i) => {
		const prev = i > 0 ? words[i - 1] : undefined;
		const standalone = words.length === 1;
		const afterPrefix = prev !== undefined && REFERENCE_PREFIX.has(prev);

		if (/^\d+$/.test(word)) {
			if (standalone || afterPrefix) found.push(Number(word) - 1);
			return;
		}
		const ordinal = ORDINALS.get(word) ?? CARDINALS.get(word);
		if (ordinal !== undefined) {
			if (standalone || afterPrefix) found.push(ordinal - 1);
			return;
		}
		if (/^[a-z]$/.test(word)) {
			if (GUARDED_LETTERS.has(word) && !(standalone || (prev !== undefined && GUARD_PREFIX.has(prev)))) return;
			found.push(word.charCodeAt(0) - "a".charCodeAt(0));
		}
	});
	return found;
}

function optionAt(options: ResolvableOption[], index: number): OptionResolution {
	const option = options[index]!;
	return { kind: "option", index, value: option.value ?? option.label };
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}

function matchByLabel(transcript: string, options: ResolvableOption[], language?: "it" | "en"): OptionResolution {
	const spoken = contentWords(transcript, language);
	if (spoken.size === 0) return { kind: "none" };
	const ranked = options
		.map((option, index) => ({ index, score: jaccard(spoken, contentWords(option.label, language)) }))
		.sort((x, y) => y.score - x.score);
	const best = ranked[0];
	if (best === undefined || best.score < MATCH_THRESHOLD) return { kind: "none" };
	const runnerUp = ranked[1]?.score ?? 0;
	if (best.score - runnerUp < MATCH_MARGIN) return { kind: "ambiguous" };
	return optionAt(options, best.index);
}

/**
 * The option a dictated transcript answers, for an option question.
 * `language` only chooses which stopword list the label match ignores; letters and ordinals are read in both languages.
 */
export function resolveOption(transcript: string, options: ResolvableOption[], language?: "it" | "en"): OptionResolution {
	const words = tokens(transcript);
	const named = referencedIndices(words);

	if (named.length > 0) {
		// A letter beyond the option count is an answer that does not exist, not a label to match.
		const inRange = named.filter((index) => index >= 0 && index < options.length);
		if (inRange.length === 0) return { kind: "none" };
		if (new Set(inRange).size === 1) return optionAt(options, inRange[0]!);
		if (words.some((w) => CORRECTION_WORDS.has(w))) return optionAt(options, inRange[inRange.length - 1]!);
		return { kind: "ambiguous" };
	}

	return matchByLabel(transcript, options, language);
}

/** The answer to an open question: the trimmed transcript, or null when nothing was said. */
export function resolveOpen(transcript: string): string | null {
	const trimmed = transcript.trim();
	return trimmed.length === 0 ? null : trimmed;
}
