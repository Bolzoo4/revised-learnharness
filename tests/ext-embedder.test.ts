// tests/ext-embedder.test.ts
// The embedding port (REQ-search-06): specs, prefixes, cosine, top-k, and the deterministic fake used by every other test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BGE_M3_SPEC,
	DEFAULT_EMBEDDER_SPEC,
	EMBEDDINGGEMMA_SPEC,
	applyPrefix,
	checkEmbedderSpec,
	cosine,
	topK,
	type EmbedderSpec,
} from "../src/core/ext/embedder.ts";
import { createFakeEmbedder } from "./helpers/fake-embedder.ts";

describe("embedder specs", () => {
	it("the default is EmbeddingGemma q8 with its search templates", () => {
		assert.equal(DEFAULT_EMBEDDER_SPEC, EMBEDDINGGEMMA_SPEC);
		assert.equal(EMBEDDINGGEMMA_SPEC.id, "onnx-community/embeddinggemma-300m-ONNX");
		assert.equal(EMBEDDINGGEMMA_SPEC.dtype, "q8");
		assert.equal(EMBEDDINGGEMMA_SPEC.dim, 768);
		assert.equal(EMBEDDINGGEMMA_SPEC.queryPrefix, "task: search result | query: ");
		assert.equal(EMBEDDINGGEMMA_SPEC.documentPrefix, "title: none | text: ");
	});

	it("bge-m3 is a selectable fallback with no prefixes", () => {
		assert.equal(BGE_M3_SPEC.id, "Xenova/bge-m3");
		assert.equal(BGE_M3_SPEC.dtype, "q8");
		assert.equal(BGE_M3_SPEC.dim, 1024);
		assert.equal(BGE_M3_SPEC.queryPrefix, "");
		assert.equal(BGE_M3_SPEC.documentPrefix, "");
	});

	it("every built-in spec is valid", () => {
		assert.deepEqual(checkEmbedderSpec(EMBEDDINGGEMMA_SPEC), []);
		assert.deepEqual(checkEmbedderSpec(BGE_M3_SPEC), []);
	});

	it("an invalid spec is reported, never accepted", () => {
		const bad: EmbedderSpec = { ...EMBEDDINGGEMMA_SPEC, id: "", dim: 0, dtype: "fp16" as "q8", pooling: "max" as "mean" };
		const problems = checkEmbedderSpec(bad);
		assert.ok(problems.some((p) => /id/.test(p)));
		assert.ok(problems.some((p) => /dim/.test(p)));
		assert.ok(problems.some((p) => /dtype/.test(p)));
		assert.ok(problems.some((p) => /pooling/.test(p)));
		assert.ok(checkEmbedderSpec({ ...EMBEDDINGGEMMA_SPEC, dim: 1.5 }).length > 0);
	});

	it("applyPrefix uses the query template for queries and the document template for documents", () => {
		assert.equal(applyPrefix(EMBEDDINGGEMMA_SPEC, "entropy", "query"), "task: search result | query: entropy");
		assert.equal(applyPrefix(EMBEDDINGGEMMA_SPEC, "entropy", "document"), "title: none | text: entropy");
		assert.equal(applyPrefix(BGE_M3_SPEC, "entropy", "query"), "entropy");
	});
});

describe("cosine", () => {
	it("is 1 for parallel vectors, 0 for orthogonal, -1 for opposite", () => {
		assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
		assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
		assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-12);
	});

	it("is 0 for a zero vector instead of NaN", () => {
		assert.equal(cosine([0, 0], [1, 1]), 0);
	});

	it("refuses vectors of different dimensions", () => {
		assert.throws(() => cosine([1, 2], [1, 2, 3]), /dimension/);
	});
});

describe("topK", () => {
	const items = [
		{ id: "a", vector: [1, 0] },
		{ id: "b", vector: [0, 1] },
		{ id: "c", vector: [0.9, 0.1] },
	];

	it("ranks by similarity, best first, and keeps k", () => {
		const out = topK([1, 0], items, 2);
		assert.deepEqual(
			out.map((h) => h.id),
			["a", "c"],
		);
		assert.ok(out[0]!.score >= out[1]!.score);
	});

	it("is stable on ties: equal scores keep input order", () => {
		const tied = [
			{ id: "x", vector: [1, 0] },
			{ id: "y", vector: [1, 0] },
			{ id: "z", vector: [1, 0] },
		];
		assert.deepEqual(
			topK([1, 0], tied, 3).map((h) => h.id),
			["x", "y", "z"],
		);
		// The same input twice gives the same order.
		assert.deepEqual(topK([1, 0], tied, 3), topK([1, 0], tied, 3));
	});

	it("returns nothing for k <= 0 and fewer items when k is larger", () => {
		assert.deepEqual(topK([1, 0], items, 0), []);
		assert.equal(topK([1, 0], items, 99).length, 3);
	});
});

describe("fake embedder (the port's test double)", () => {
	it("returns one vector of the spec dimension per text, deterministic for the same input", async () => {
		const e = createFakeEmbedder({ dim: 16 });
		const [a1, b1] = await e.embed(["entropy", "heat"], "document");
		const [a2] = await e.embed(["entropy"], "document");
		assert.equal(a1!.length, 16);
		assert.equal(b1!.length, 16);
		assert.deepEqual(Array.from(a1!), Array.from(a2!));
	});

	it("records the prefixed text it was given, so the templates are testable", async () => {
		const e = createFakeEmbedder({ dim: 8, spec: EMBEDDINGGEMMA_SPEC });
		await e.embed(["entropy"], "query");
		await e.embed(["entropy"], "document");
		assert.deepEqual(e.seen, [
			{ kind: "query", text: "task: search result | query: entropy" },
			{ kind: "document", text: "title: none | text: entropy" },
		]);
	});

	it("maps synonyms onto one concept, so a paraphrase with no shared words is close", async () => {
		const e = createFakeEmbedder({ dim: 64, synonyms: { warmth: "heat", temperature: "heat" } });
		const [doc] = await e.embed(["heat transfer"], "document");
		const [query] = await e.embed(["temperature transfer"], "query");
		const [other] = await e.embed(["bayesian priors"], "query");
		assert.ok(cosine(doc!, query!) > cosine(doc!, other!));
	});

	it("fails when told to, so error paths can be tested", async () => {
		const e = createFakeEmbedder({ dim: 8, fail: new Error("boom") });
		await assert.rejects(e.embed(["x"], "query"), /boom/);
	});
});
