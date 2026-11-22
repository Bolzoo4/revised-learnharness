// tests/helpers/fake-embedder.ts
// A deterministic Embedder for tests: no model, no network. Each token (after synonym mapping) hashes into one
// bucket of a fixed-size vector; the vector is L2-normalised. Texts sharing words are close; synonyms given in
// `synonyms` land in the same bucket, which lets a test express a paraphrase with no shared words.

import { createHash } from "node:crypto";

import { applyPrefix, DEFAULT_EMBEDDER_SPEC, type EmbedKind, type Embedder, type EmbedderSpec } from "../../src/core/ext/embedder.ts";

export interface FakeEmbedderOptions {
	dim?: number;
	spec?: EmbedderSpec;
	/** token -> canonical token: both map to the same bucket. */
	synonyms?: Record<string, string>;
	/** When set, every embed call rejects with this error. */
	fail?: Error;
}

export interface FakeEmbedder extends Embedder {
	/** Every text the embedder was asked to embed, after the spec's prefix, in call order. */
	readonly seen: Array<{ kind: EmbedKind; text: string }>;
}

export function createFakeEmbedder(options: FakeEmbedderOptions = {}): FakeEmbedder {
	const spec = options.spec ?? DEFAULT_EMBEDDER_SPEC;
	const dim = options.dim ?? spec.dim;
	const synonyms = options.synonyms ?? {};
	const seen: Array<{ kind: EmbedKind; text: string }> = [];

	function vectorOf(text: string): Float32Array {
		const v = new Float32Array(dim);
		for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
			if (raw === "") continue;
			const token = synonyms[raw] ?? raw;
			const bucket = createHash("sha256").update(token).digest().readUInt32BE(0) % dim;
			v[bucket] = v[bucket]! + 1;
		}
		let norm = 0;
		for (const x of v) norm += x * x;
		norm = Math.sqrt(norm);
		if (norm > 0) for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
		return v;
	}

	return {
		spec,
		seen,
		async embed(texts, kind) {
			if (options.fail) throw options.fail;
			return texts.map((text) => {
				const prefixed = applyPrefix(spec, text, kind);
				seen.push({ kind, text: prefixed });
				return vectorOf(prefixed);
			});
		},
	};
}
