// tests/ext-mcp-semantic-reader.test.ts
// The MCP server's semantic reader (REQ-search-09): lazy, in memory, read-only. Real files in a temp dir; the fake embedder.

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { EMBEDDINGGEMMA_SPEC, type EmbedderLoad } from "../src/core/ext/embedder.ts";
import { applyUpdate, emptyIndex, encodeIndex } from "../src/core/ext/vector-index.ts";
import { createSemanticReader } from "../src/server/ext/mcp/semantic.ts";
import { writeVectorIndex, vectorIndexPath } from "../src/server/ext/vector-index-store.ts";
import { createFakeEmbedder } from "./helpers/fake-embedder.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const SPEC = { ...EMBEDDINGGEMMA_SPEC, dim: 8 };

function freshFile(): string {
	const root = mkdtempSync(join(tmpdir(), "ext-mcp-semantic-"));
	roots.push(root);
	mkdirSync(join(root, "ext"), { recursive: true });
	return vectorIndexPath(root);
}

function indexWith(ids: string[], modelId = SPEC.id, dim = SPEC.dim) {
	const base = emptyIndex({ id: modelId, dim });
	return applyUpdate(base, {
		upserts: ids.map((id, i) => ({ id, hash: `h${i}`, vector: Float32Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0)) })),
		drop: [],
	});
}

function okLoader() {
	let calls = 0;
	const fake = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC });
	const load = async (): Promise<EmbedderLoad> => {
		calls++;
		return { ok: true, embedder: fake };
	};
	return {
		load,
		get calls() {
			return calls;
		},
	};
}

describe("createSemanticReader", () => {
	it("reports that the index is not built yet when the file is missing", async () => {
		const reader = createSemanticReader(freshFile(), SPEC, okLoader().load);
		const state = await reader.load();
		assert.equal(state.ok, false);
		if (!state.ok) assert.match(state.reason, /not been built yet/);
	});

	it("answers from the stored index and embeds the query with the loaded embedder", async () => {
		const file = freshFile();
		writeVectorIndex(file, indexWith(["n_a", "n_b"]));
		const reader = createSemanticReader(file, SPEC, okLoader().load);
		const state = await reader.load();
		assert.equal(state.ok, true);
		if (!state.ok) return;
		assert.deepEqual(state.index.ids, ["n_a", "n_b"]);
		const q = await state.embedQuery("entropy");
		assert.equal(q.length, SPEC.dim);
	});

	it("loads the embedder once, and reads the index again only when the file changes", async () => {
		const file = freshFile();
		writeVectorIndex(file, indexWith(["n_a"]));
		const loader = okLoader();
		const reader = createSemanticReader(file, SPEC, loader.load);
		const first = await reader.load();
		const again = await reader.load();
		assert.equal(loader.calls, 1);
		assert.equal(first.ok && again.ok && first.index === again.index, true, "same in-memory index while the file is unchanged");

		// the app writes a new index; a later call sees it
		const bytes = encodeIndex(indexWith(["n_a", "n_b", "n_c"]));
		fs.writeFileSync(file, bytes);
		const later = new Date(Date.now() + 5000);
		utimesSync(file, later, later);
		const after2 = await reader.load();
		assert.ok(after2.ok);
		if (after2.ok) assert.deepEqual(after2.index.ids, ["n_a", "n_b", "n_c"]);
	});

	it("an index of another model is refused, and the app is said to rebuild it", async () => {
		const file = freshFile();
		writeVectorIndex(file, indexWith(["n_a"], "some/other-model"));
		const state = await createSemanticReader(file, SPEC, okLoader().load).load();
		assert.equal(state.ok, false);
		if (!state.ok) assert.match(state.reason, /another model/);
	});

	it("a corrupt index file is reported, not used", async () => {
		const file = freshFile();
		fs.writeFileSync(file, "junk");
		const state = await createSemanticReader(file, SPEC, okLoader().load).load();
		assert.equal(state.ok, false);
	});

	it("an unavailable model is reported with the loader's reason, and nothing is cached as loaded", async () => {
		const file = freshFile();
		writeVectorIndex(file, indexWith(["n_a"]));
		let calls = 0;
		const reader = createSemanticReader(file, SPEC, async () => {
			calls++;
			return { ok: false, reason: "unavailable: model not downloaded" };
		});
		const first = await reader.load();
		assert.equal(first.ok, false);
		if (!first.ok) assert.equal(first.reason, "unavailable: model not downloaded");
		await reader.load();
		assert.equal(calls, 2, "a failed load is retried on the next call");
	});

	it("never writes: the data directory is byte-identical after loading and embedding", async () => {
		const file = freshFile();
		writeVectorIndex(file, indexWith(["n_a", "n_b"]));
		const dir = join(file, "..");
		const bytesBefore = readFileSync(file);
		const namesBefore = readdirSync(dir).sort();
		const reader = createSemanticReader(file, SPEC, okLoader().load);
		const state = await reader.load();
		if (state.ok) await state.embedQuery("anything");
		assert.deepEqual(readFileSync(file), bytesBefore);
		assert.deepEqual(readdirSync(dir).sort(), namesBefore);
	});

	it("unavailable() answers synchronously for a missing or unusable file, and is null for a usable one", async () => {
		const file = freshFile();
		const reader = createSemanticReader(file, SPEC, okLoader().load);
		assert.match(reader.unavailable?.() ?? "", /not been built yet/);
		writeVectorIndex(file, indexWith(["n_a"], "some/other-model"));
		assert.equal(reader.unavailable?.(), null, "unknown until the file is read");
		await reader.load();
		assert.match(reader.unavailable?.() ?? "", /another model/);
		writeVectorIndex(file, indexWith(["n_a"]));
		await new Promise((r) => setTimeout(r, 5));
		const later = new Date(Date.now() + 5000);
		utimesSync(file, later, later);
		assert.equal(reader.unavailable?.(), null, "a changed file is unknown again until it is read");
	});

	it("exposes only read methods: no write method", () => {
		const reader = createSemanticReader(freshFile(), SPEC, okLoader().load);
		assert.deepEqual(Object.keys(reader).sort(), ["load", "unavailable"]);
	});
});
