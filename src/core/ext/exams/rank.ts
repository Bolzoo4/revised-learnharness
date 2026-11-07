// src/core/ext/exams/rank.ts
/**
 * Lexical ranking for material search (REQ-ex-05): BM25 over a Unicode-normalising
 * tokenizer. No stop-word list: a word common across the material gets a low IDF on its
 * own, so the ranker needs no language-specific list. This is the one function that an
 * embedding ranker would replace.
 */

import { estimateTokens, truncateToTokens } from "./tokens.ts";

/** Lower-cased letters and digits, accents removed. Anything else separates tokens. */
export function tokenize(text: string): string[] {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export interface Rankable {
	text: string;
}

export interface Ranked<T> {
	item: T;
	score: number;
}

const K1 = 1.2;
const B = 0.75;

/** The items that share a query term, best first. Ties keep the input order. Items with no shared term are left out. */
export function bm25<T extends Rankable>(query: string, items: readonly T[]): Ranked<T>[] {
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0 || items.length === 0) return [];
	const docs = items.map((item) => {
		const tokens = tokenize(item.text);
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		return { item, len: tokens.length, tf };
	});
	const avgLen = docs.reduce((sum, d) => sum + d.len, 0) / docs.length || 1;
	const n = docs.length;
	const df = new Map<string, number>();
	for (const term of terms) df.set(term, docs.reduce((count, d) => count + (d.tf.has(term) ? 1 : 0), 0));
	const scored: Array<Ranked<T> & { index: number }> = [];
	docs.forEach((doc, index) => {
		let score = 0;
		for (const term of terms) {
			const f = doc.tf.get(term) ?? 0;
			if (f === 0) continue;
			const dfTerm = df.get(term) ?? 0;
			const idf = Math.log(1 + (n - dfTerm + 0.5) / (dfTerm + 0.5));
			score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avgLen)));
		}
		if (score > 0) scored.push({ item: doc.item, score, index });
	});
	return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ item, score }) => ({ item, score }));
}

/**
 * The best hits within a count and a token budget, in rank order. A hit that does not fit
 * the remaining budget is cut to fit (only when no hit fits whole before it); the scan stops
 * when the budget is spent. An empty list means nothing matched.
 */
export function selectWithinBudget<T extends Rankable>(ranked: readonly Ranked<T>[], k: number, maxTokens: number): Array<Ranked<T> & { text: string }> {
	const out: Array<Ranked<T> & { text: string }> = [];
	let used = 0;
	for (const r of ranked) {
		if (out.length >= k) break;
		const remaining = maxTokens - used;
		if (remaining <= 0) break;
		const text = estimateTokens(r.item.text) <= remaining ? r.item.text : truncateToTokens(r.item.text, remaining);
		if (text === "") break;
		used += estimateTokens(text);
		out.push({ ...r, text });
	}
	return out;
}
