// tests/ext-embedder-transformers.test.ts
// The Transformers.js adapter (REQ-search-06) with an injected extractor factory: no model is loaded, no network is used.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { EMBEDDINGGEMMA_SPEC, MODEL_UNAVAILABLE } from "../src/core/ext/embedder.ts";
import {
	createTransformersEmbedder,
	createTransformersLoader,
	missingModelFiles,
	type ExtractorFactory,
} from "../src/server/ext/embedder-transformers.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const SPEC = { ...EMBEDDINGGEMMA_SPEC, dim: 4 };

function emptyCache(): string {
	const root = mkdtempSync(join(tmpdir(), "ext-embedder-tf-"));
	roots.push(root);
	return root;
}

/** Writes the files a complete model download leaves in the cache. */
function installModel(cacheDir: string, spec = SPEC): void {
	const dir = join(cacheDir, spec.id);
	mkdirSync(join(dir, "onnx"), { recursive: true });
	for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
		writeFileSync(join(dir, f), "{}");
	}
}

interface Call {
	modelId: string;
	cacheDir: string;
	allowDownload: boolean;
}

/** A factory that records its calls and returns an extractor echoing a fixed vector (text length in slot 0). */
function recordingFactory() {
	const calls: Call[] = [];
	const inputs: Array<{ text: string; options: unknown }> = [];
	const factory: ExtractorFactory = async (modelId, opts) => {
		calls.push({ modelId, cacheDir: opts.cacheDir, allowDownload: opts.allowDownload });
		return async (text, options) => {
			inputs.push({ text, options });
			return { data: new Float32Array([text.length, 0, 0, 1]) };
		};
	};
	return { factory, calls, inputs };
}

describe("missingModelFiles", () => {
	it("lists every required file when the cache is empty", () => {
		const cache = emptyCache();
		assert.equal(missingModelFiles(SPEC, cache).length, 4);
	});

	it("a partial download (no weights) is still missing", () => {
		const cache = emptyCache();
		installModel(cache);
		rmSync(join(cache, SPEC.id, "onnx"), { recursive: true, force: true });
		assert.deepEqual(missingModelFiles(SPEC, cache), ["onnx/model_quantized.onnx"]);
	});

	it("is empty when the model is complete", () => {
		const cache = emptyCache();
		installModel(cache);
		assert.deepEqual(missingModelFiles(SPEC, cache), []);
	});
});

describe("createTransformersLoader (lazy, never downloads by default)", () => {
	it("an empty cache refuses with the not-downloaded reason and never calls the factory", async () => {
		const cache = emptyCache();
		const { factory, calls } = recordingFactory();
		const load = createTransformersLoader(SPEC, { cacheDir: cache, factory });
		const result = await load();
		assert.deepEqual(result, { ok: false, reason: MODEL_UNAVAILABLE });
		assert.equal(MODEL_UNAVAILABLE, "unavailable: model not downloaded");
		assert.equal(calls.length, 0);
	});

	it("becomes available once the files appear, without a restart", async () => {
		const cache = emptyCache();
		const { factory, calls } = recordingFactory();
		const load = createTransformersLoader(SPEC, { cacheDir: cache, factory });
		assert.equal((await load()).ok, false);
		installModel(cache);
		const result = await load();
		assert.equal(result.ok, true);
		assert.equal(calls.length, 0, "the pipeline itself loads on the first embed, not on the loader call");
	});

	it("hands out the same embedder on every call", async () => {
		const cache = emptyCache();
		installModel(cache);
		const { factory } = recordingFactory();
		const load = createTransformersLoader(SPEC, { cacheDir: cache, factory });
		const a = await load();
		const b = await load();
		assert.equal(a.ok && b.ok && a.embedder === b.embedder, true);
	});
});

describe("createTransformersEmbedder", () => {
	it("loads from the cache directory with downloads disabled, once", async () => {
		const cache = emptyCache();
		installModel(cache);
		const { factory, calls } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory });
		await embedder.embed(["uno"], "document");
		await embedder.embed(["due"], "query");
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { modelId: SPEC.id, cacheDir: cache, allowDownload: false });
	});

	it("applies the query template to queries and the document template to documents", async () => {
		const cache = emptyCache();
		installModel(cache);
		const { factory, inputs } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory });
		await embedder.embed(["entropy"], "query");
		await embedder.embed(["entropy"], "document");
		assert.equal(inputs[0]!.text, "task: search result | query: entropy");
		assert.equal(inputs[1]!.text, "title: none | text: entropy");
	});

	it("asks for the spec's pooling and normalised output", async () => {
		const cache = emptyCache();
		installModel(cache);
		const { factory, inputs } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory });
		await embedder.embed(["x"], "document");
		assert.deepEqual(inputs[0]!.options, { pooling: "mean", normalize: true });
	});

	it("returns one Float32Array per text, in order", async () => {
		const cache = emptyCache();
		installModel(cache);
		const { factory } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory });
		const out = await embedder.embed(["a", "bb", "ccc"], "document");
		assert.equal(out.length, 3);
		assert.ok(out.every((v) => v instanceof Float32Array && v.length === SPEC.dim));
		assert.deepEqual(
			out.map((v) => v[0]),
			["title: none | text: a".length, "title: none | text: bb".length, "title: none | text: ccc".length],
		);
	});

	it("a vector of the wrong dimension is an error, never stored", async () => {
		const cache = emptyCache();
		installModel(cache);
		const wrong: ExtractorFactory = async () => async () => ({ data: new Float32Array(7) });
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory: wrong });
		await assert.rejects(embedder.embed(["x"], "document"), /expected 4/);
	});

	it("with an empty cache, embed rejects with the not-downloaded reason and no factory call", async () => {
		const cache = emptyCache();
		const { factory, calls } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory });
		await assert.rejects(embedder.embed(["x"], "document"), /unavailable: model not downloaded/);
		assert.equal(calls.length, 0);
	});

	it("allowDownload=true passes the request through (the owner's download command only)", async () => {
		const cache = emptyCache();
		const { factory, calls } = recordingFactory();
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, allowDownload: true, factory });
		await embedder.embed(["x"], "document");
		assert.equal(calls[0]!.allowDownload, true);
	});

	it("a failed load is retried on the next call", async () => {
		const cache = emptyCache();
		installModel(cache);
		let attempts = 0;
		const flaky: ExtractorFactory = async () => {
			attempts++;
			if (attempts === 1) throw new Error("disk busy");
			return async () => ({ data: new Float32Array(SPEC.dim) });
		};
		const embedder = createTransformersEmbedder(SPEC, { cacheDir: cache, factory: flaky });
		await assert.rejects(embedder.embed(["x"], "document"), /disk busy/);
		await embedder.embed(["x"], "document");
		assert.equal(attempts, 2);
	});

	it("an invalid spec is refused at construction", () => {
		assert.throws(() => createTransformersEmbedder({ ...SPEC, dim: 0 }, { cacheDir: emptyCache() }), RangeError);
	});
});
