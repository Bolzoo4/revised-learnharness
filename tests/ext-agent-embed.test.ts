// tests/ext-agent-embed.test.ts
// The app's query-embedding service (POST /api/ext/agent/embed-query): input checks, the unavailable answer, and the
// vector answer. The fake embedder stands in for the model; no model is loaded.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMBEDDINGGEMMA_SPEC, MODEL_UNAVAILABLE, type EmbedderLoad } from "../src/core/ext/embedder.ts";
import { embedAgentQuery, MAX_EMBED_QUERY_CHARS } from "../src/server/ext/agent-embed.ts";
import { createFakeEmbedder } from "./helpers/fake-embedder.ts";

const SPEC = { ...EMBEDDINGGEMMA_SPEC, dim: 8 };

function okLoad(): () => Promise<EmbedderLoad> {
	const embedder = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC });
	return async () => ({ ok: true, embedder });
}

const unavailableLoad = async (): Promise<EmbedderLoad> => ({ ok: false, reason: MODEL_UNAVAILABLE });

describe("embedAgentQuery input checks", () => {
	it("refuses a body without a text string, with the field named", async () => {
		for (const raw of [{}, { text: 5 }, { text: null }]) {
			const out = await embedAgentQuery(raw, { spec: SPEC, load: okLoad() });
			assert.equal(out.status, 400);
			assert.match(out.body.error ?? "", /text/);
		}
	});

	it("refuses an empty text after trimming", async () => {
		const out = await embedAgentQuery({ text: "   " }, { spec: SPEC, load: okLoad() });
		assert.equal(out.status, 400);
	});

	it("refuses a text longer than the bound, and accepts one exactly at the bound", async () => {
		const over = await embedAgentQuery({ text: "a".repeat(MAX_EMBED_QUERY_CHARS + 1) }, { spec: SPEC, load: okLoad() });
		assert.equal(over.status, 400);
		assert.match(over.body.error ?? "", /2000/);
		const at = await embedAgentQuery({ text: "a".repeat(MAX_EMBED_QUERY_CHARS) }, { spec: SPEC, load: okLoad() });
		assert.equal(at.status, 200);
	});

	it("accepts kind query or no kind, and refuses any other kind", async () => {
		assert.equal((await embedAgentQuery({ text: "heat", kind: "query" }, { spec: SPEC, load: okLoad() })).status, 200);
		assert.equal((await embedAgentQuery({ text: "heat" }, { spec: SPEC, load: okLoad() })).status, 200);
		const doc = await embedAgentQuery({ text: "heat", kind: "document" }, { spec: SPEC, load: okLoad() });
		assert.equal(doc.status, 400);
	});

	it("refuses unknown fields", async () => {
		const out = await embedAgentQuery({ text: "heat", model: "other" }, { spec: SPEC, load: okLoad() });
		assert.equal(out.status, 400);
	});
});

describe("embedAgentQuery answers", () => {
	it("answers 503 with the reason when the model is not downloaded", async () => {
		const out = await embedAgentQuery({ text: "heat" }, { spec: SPEC, load: unavailableLoad });
		assert.equal(out.status, 503);
		assert.deepEqual(out.body, { unavailable: MODEL_UNAVAILABLE });
	});

	it("answers 503 with a fixed reason when the embedding itself fails", async () => {
		const broken = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC, fail: new Error("/private/path/boom") });
		const out = await embedAgentQuery({ text: "heat" }, { spec: SPEC, load: async () => ({ ok: true, embedder: broken }) });
		assert.equal(out.status, 503);
		assert.deepEqual(out.body, { unavailable: "query embedding failed" });
	});

	it("answers 200 with the vector, the model id and the dimension", async () => {
		const out = await embedAgentQuery({ text: "heat", kind: "query" }, { spec: SPEC, load: okLoad() });
		assert.equal(out.status, 200);
		if (out.status !== 200) return;
		assert.equal(out.body.modelId, SPEC.id);
		assert.equal(out.body.dim, SPEC.dim);
		assert.equal(out.body.vector.length, SPEC.dim);
		assert.ok(out.body.vector.every((x) => typeof x === "number" && Number.isFinite(x)));
	});

	it("embeds the text with the query template, not the document one", async () => {
		const embedder = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC });
		await embedAgentQuery({ text: "heat" }, { spec: SPEC, load: async () => ({ ok: true, embedder }) });
		assert.deepEqual(embedder.seen, [{ kind: "query", text: `${SPEC.queryPrefix}heat` }]);
	});
});
