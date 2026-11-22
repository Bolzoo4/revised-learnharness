// src/core/ext/embedder.ts
/**
 * The embedding port for semantic node search (REQ-search-06). Pure: no model,
 * no IO. The model runs behind `Embedder`; an adapter (the Transformers.js one,
 * not in this change) implements it. Tests use the deterministic fake in
 * tests/helpers/fake-embedder.ts.
 *
 * Templates: EmbeddingGemma expects a task prefix on queries and a title/text
 * prefix on documents. bge-m3 takes plain text. The EmbeddingGemma templates
 * come from the research notes (docs/search-embedding-models.md) and must be
 * checked against the model card before the first release.
 */

export type EmbedKind = "query" | "document";

export interface EmbedderSpec {
	/** The model id the adapter loads (e.g. a Hugging Face repo). */
	id: string;
	/** Quantisation. q8 only: fp16 is not used for these models. */
	dtype: "q8";
	/** Vector length. */
	dim: number;
	/** How token vectors become one vector (the adapter applies it). */
	pooling: "mean" | "cls";
	queryPrefix: string;
	documentPrefix: string;
}

/** The port. `embed` returns one vector per text, in order. */
export interface Embedder {
	readonly spec: EmbedderSpec;
	embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export const EMBEDDINGGEMMA_SPEC: EmbedderSpec = Object.freeze({
	id: "onnx-community/embeddinggemma-300m-ONNX",
	dtype: "q8",
	dim: 768,
	pooling: "mean",
	queryPrefix: "task: search result | query: ",
	documentPrefix: "title: none | text: ",
});

/** Pooling and prefixes for bge-m3 are unverified until its card is checked (the benchmark decides). */
export const BGE_M3_SPEC: EmbedderSpec = Object.freeze({
	id: "Xenova/bge-m3",
	dtype: "q8",
	dim: 1024,
	pooling: "cls",
	queryPrefix: "",
	documentPrefix: "",
});

export const DEFAULT_EMBEDDER_SPEC: EmbedderSpec = EMBEDDINGGEMMA_SPEC;

/** Problems with a spec (empty = valid). */
export function checkEmbedderSpec(spec: EmbedderSpec): string[] {
	const problems: string[] = [];
	if (typeof spec.id !== "string" || spec.id.trim() === "") problems.push("id must be a non-empty string");
	if (!Number.isInteger(spec.dim) || spec.dim <= 0) problems.push("dim must be a positive integer");
	if (spec.dtype !== "q8") problems.push(`dtype must be "q8", got "${String(spec.dtype)}"`);
	if (spec.pooling !== "mean" && spec.pooling !== "cls") problems.push(`pooling must be "mean" or "cls", got "${String(spec.pooling)}"`);
	if (typeof spec.queryPrefix !== "string") problems.push("queryPrefix must be a string");
	if (typeof spec.documentPrefix !== "string") problems.push("documentPrefix must be a string");
	return problems;
}

/** The text the model sees: the template for the kind, then the text. */
export function applyPrefix(spec: EmbedderSpec, text: string, kind: EmbedKind): string {
	return (kind === "query" ? spec.queryPrefix : spec.documentPrefix) + text;
}

/** Cosine similarity. A zero vector scores 0 (never NaN). Different lengths are a bug and throw. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) throw new RangeError(`vector dimension mismatch: ${a.length} vs ${b.length}`);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredId {
	id: string;
	score: number;
}

/**
 * The k items most similar to the query, best first. Ties keep input order
 * (Array.prototype.sort is stable), so the same input always gives the same
 * answer. k <= 0 gives nothing.
 */
export function topK(query: ArrayLike<number>, items: ReadonlyArray<{ id: string; vector: ArrayLike<number> }>, k: number): ScoredId[] {
	if (!(k > 0)) return [];
	return items
		.map((item) => ({ id: item.id, score: cosine(query, item.vector) }))
		.sort((x, y) => y.score - x.score)
		.slice(0, Math.floor(k));
}

/** The message the app and the MCP server show while no model adapter is installed. */
export const MODEL_UNAVAILABLE = "unavailable: model not installed";

/** An embedder, or the reason none can be had. */
export type EmbedderLoad = { ok: true; embedder: Embedder } | { ok: false; reason: string };

/** The loader until the model adapter exists: always unavailable. */
export function unavailableEmbedder(): Promise<EmbedderLoad> {
	return Promise.resolve({ ok: false, reason: MODEL_UNAVAILABLE });
}
