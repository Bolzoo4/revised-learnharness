// src/core/ext/exams/search.ts
/**
 * Search options and the search itself over chunks of several materials (REQ-ex-05). The
 * caller's K and token cap are clamped to what the service allows; a missing value takes the
 * default. Pure: the chunks come in, the hits go out.
 */

import type { SearchHit } from "./types.ts";
import { MAX_QUERY_CHARS } from "./bounds.ts";
import { bm25, selectWithinBudget } from "./rank.ts";

export const DEFAULT_K = 5;
export const MAX_K = 10;
export const DEFAULT_MAX_TOKENS = 1500;
export const MAX_SEARCH_TOKENS = 3000;

export interface SearchOptions {
	k: number;
	maxTokens: number;
}

function bounded(v: unknown, fallback: number, max: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(v)));
}

/** K and the token cap, each clamped to [1, the service maximum]; absent or non-numeric values take the default. */
export function searchOptions(opts: { k?: unknown; maxTokens?: unknown } = {}): SearchOptions {
	return {
		k: bounded(opts.k, DEFAULT_K, MAX_K),
		maxTokens: bounded(opts.maxTokens, DEFAULT_MAX_TOKENS, MAX_SEARCH_TOKENS),
	};
}

/** A query, flattened to one line and bounded. Empty means "nothing to search for". */
export function searchQuery(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

export interface SearchChunk {
	materialId: string;
	title: string;
	page: number;
	text: string;
}

/** The best chunks for the query within the options. Empty when nothing matches. */
export function searchChunks(query: string, chunks: readonly SearchChunk[], opts: SearchOptions): SearchHit[] {
	const q = searchQuery(query);
	if (q === "") return [];
	const ranked = bm25(q, chunks);
	return selectWithinBudget(ranked, opts.k, opts.maxTokens).map((hit) => ({
		materialId: hit.item.materialId,
		title: hit.item.title,
		page: hit.item.page,
		text: hit.text,
		score: Math.round(hit.score * 1000) / 1000,
	}));
}
