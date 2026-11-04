// src/core/ext/quote.ts
/**
 * Quote check (REQ-src-05). A quotation counts only if, after NORMALIZATION,
 * it occurs verbatim in the stored snapshot. Normalization covers exactly:
 * whitespace, hyphenation at line breaks, case and unicode form (NFKC, plus
 * folding of typographic quotes, dashes and the soft hyphen). No fuzzy
 * matching. Hyphenation is ambiguous ("well-\nknown" vs "interna-\ntional"),
 * so both readings are tried: hyphen dropped ("join") and hyphen kept ("keep").
 */

/** A quote shorter than this (after normalization) is evidence of nothing. */
export const MIN_QUOTE_CHARS = 20;

export type HyphenMode = "join" | "keep";
export type QuoteCheck = "ok" | "quote_too_short" | "quote_not_found";

export function normalizeForMatch(text: string, hyphen: HyphenMode): string {
	let s = text.normalize("NFKC");
	s = s.replace(/­/g, "");
	s = s.replace(/[‘’‚‛′]/g, "'");
	s = s.replace(/[“”„‟″]/g, '"');
	s = s.replace(/[‐‑‒–—―−]/g, "-");
	s = s.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, hyphen === "join" ? "$1$2" : "$1-$2");
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Pure and deterministic: the same snapshot and quote always give the same verdict. */
export function checkQuote(snapshot: string, quote: string): QuoteCheck {
	const joined = normalizeForMatch(quote, "join");
	if (joined.length < MIN_QUOTE_CHARS) return "quote_too_short";
	if (normalizeForMatch(snapshot, "join").includes(joined)) return "ok";
	const kept = normalizeForMatch(quote, "keep");
	return normalizeForMatch(snapshot, "keep").includes(kept) ? "ok" : "quote_not_found";
}
