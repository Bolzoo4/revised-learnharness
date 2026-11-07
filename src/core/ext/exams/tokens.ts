// src/core/ext/exams/tokens.ts
/**
 * Token estimate for the retrieval cap (REQ-ex-05). A character count divided by three rounded up:
 * deliberately conservative for Italian and English text, and free of any tokenizer dependency.
 */

const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The longest prefix of `text` whose estimate fits `maxTokens`, cut at a space when one is near, with a marker when cut. */
export function truncateToTokens(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	if (estimateTokens(text) <= maxTokens) return text;
	const limit = Math.max(0, maxTokens * CHARS_PER_TOKEN - 1);
	let cut = text.slice(0, limit);
	const space = cut.lastIndexOf(" ");
	if (space > limit * 0.6) cut = cut.slice(0, space);
	return `${cut.trimEnd()}…`;
}
