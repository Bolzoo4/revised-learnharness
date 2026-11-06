// src/core/ext/study/bounds.ts
/**
 * Size and shape limits shared by the study parsers. Every value that comes
 * from a file, a model or the learner is bounded here before it is stored or
 * handed on, so one bad line cannot make the rest of a ledger unusable.
 */

/** Highest page number a parser accepts (a PDF with more pages is not a study document). */
export const MAX_PAGE = 100000;
/** Longest document title kept. */
export const MAX_TITLE_CHARS = 200;
/** Longest proposition, question or answer kept; longer text is cut. */
export const MAX_TEXT_CHARS = 1000;

/**
 * Flattens every run of whitespace (including \r, \n, U+2028 and U+2029) to a
 * single space, trims, and cuts to `maxChars` UTF-16 units without splitting a
 * surrogate pair. The result is one line that cannot start a markdown block.
 */
export function flattenText(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	let out = "";
	for (const ch of flat) {
		if (out.length + ch.length > maxChars) break;
		out += ch;
	}
	return out.trimEnd();
}
