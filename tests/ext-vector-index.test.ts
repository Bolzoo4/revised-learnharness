// tests/ext-vector-index.test.ts
// The node vector index (REQ-search-07): the pure part (text, diff, apply, codec, ranking) and the store (atomic file).

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BGE_M3_SPEC, EMBEDDINGGEMMA_SPEC } from "../src/core/ext/embedder.ts";
import {
	applyUpdate,
	baseFor,
	decodeIndex,
	emptyIndex,
	encodeIndex,
	indexText,
	planUpdate,
	rankIndex,
	textHash,
	type VectorIndex,
} from "../src/core/ext/vector-index.ts";
import { readVectorIndex, vectorIndexPath, writeVectorIndex } from "../src/server/ext/vector-index-store.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function vec(...xs: number[]): Float32Array {
	return Float32Array.from(xs);
}

function indexOf(rows: Array<{ id: string; hash: string; vector: Float32Array }>, dim = 3): VectorIndex {
	let index = emptyIndex({ id: "model-a", dim });
	index = applyUpdate(index, { upserts: rows, drop: [] });
	return index;
}

describe("indexText and textHash", () => {
	it("joins name, aliases and statement in that order with a fixed separator", () => {
		assert.equal(
			indexText({ name: "Entropy", aliases: ["disorder", "S"], statement: "Entropy never decreases." }),
			"Entropy\ndisorder\nS\nEntropy never decreases.",
		);
		assert.equal(indexText({ name: "Heat", aliases: [], statement: "Heat flows." }), "Heat\nHeat flows.");
	});

	it("hashes deterministically and changes when the text changes", () => {
		assert.equal(textHash("abc"), textHash("abc"));
		assert.notEqual(textHash("abc"), textHash("abd"));
		assert.match(textHash("abc"), /^[0-9a-f]{64}$/);
	});
});

describe("planUpdate", () => {
	it("from an empty index every node is to be embedded and nothing is dropped", () => {
		const plan = planUpdate(
			[
				{ id: "n_1", hash: "h1" },
				{ id: "n_2", hash: "h2" },
			],
			emptyIndex({ id: "model-a", dim: 3 }),
		);
		assert.deepEqual(plan, { embed: ["n_1", "n_2"], drop: [] });
	});

	it("embeds only new or changed nodes and drops vanished ones", () => {
		const index = indexOf([
			{ id: "n_a", hash: "ha", vector: vec(1, 0, 0) },
			{ id: "n_b", hash: "hb-old", vector: vec(0, 1, 0) },
			{ id: "n_gone", hash: "hg", vector: vec(0, 0, 1) },
		]);
		const plan = planUpdate(
			[
				{ id: "n_a", hash: "ha" },
				{ id: "n_b", hash: "hb-new" },
				{ id: "n_c", hash: "hc" },
			],
			index,
		);
		assert.deepEqual(plan, { embed: ["n_b", "n_c"], drop: ["n_gone"] });
	});
});

describe("baseFor (stale check)", () => {
	it("keeps a loaded index whose model and dimension match the active spec", () => {
		const loaded = emptyIndex({ id: EMBEDDINGGEMMA_SPEC.id, dim: EMBEDDINGGEMMA_SPEC.dim });
		assert.equal(baseFor(EMBEDDINGGEMMA_SPEC, loaded), loaded);
	});

	it("discards an index written by another model or dimension, so the caller rebuilds from scratch", () => {
		const loaded = emptyIndex({ id: BGE_M3_SPEC.id, dim: BGE_M3_SPEC.dim });
		const base = baseFor(EMBEDDINGGEMMA_SPEC, loaded);
		assert.equal(base.modelId, EMBEDDINGGEMMA_SPEC.id);
		assert.equal(base.ids.length, 0);
	});

	it("a missing index starts empty", () => {
		assert.equal(baseFor(EMBEDDINGGEMMA_SPEC, null).ids.length, 0);
	});
});

describe("applyUpdate", () => {
	it("replaces an upserted id in place, appends new ids, removes dropped ids, and leaves the input untouched", () => {
		const before = indexOf([
			{ id: "n_a", hash: "ha", vector: vec(1, 0, 0) },
			{ id: "n_b", hash: "hb", vector: vec(0, 1, 0) },
		]);
		const after1 = applyUpdate(before, {
			upserts: [
				{ id: "n_b", hash: "hb2", vector: vec(0, 0, 1) },
				{ id: "n_c", hash: "hc", vector: vec(1, 1, 0) },
			],
			drop: ["n_a"],
		});
		assert.deepEqual(after1.ids, ["n_b", "n_c"]);
		assert.deepEqual(after1.hashes, ["hb2", "hc"]);
		assert.deepEqual(Array.from(after1.vectors), [0, 0, 1, 1, 1, 0]);
		// the input index is unchanged
		assert.deepEqual(before.ids, ["n_a", "n_b"]);
		assert.deepEqual(Array.from(before.vectors), [1, 0, 0, 0, 1, 0]);
	});

	it("refuses a vector of the wrong dimension", () => {
		assert.throws(() => applyUpdate(emptyIndex({ id: "m", dim: 3 }), { upserts: [{ id: "n_x", hash: "h", vector: vec(1, 2) }], drop: [] }), /dimension/);
	});
});

describe("encodeIndex / decodeIndex", () => {
	it("round-trips ids, hashes, model, dimension and exact float32 values", () => {
		const index = indexOf([
			{ id: "n_a", hash: "ha", vector: vec(0.25, -1, 3) },
			{ id: "n_b", hash: "hb", vector: vec(0, 0.5, 2) },
		]);
		const back = decodeIndex(encodeIndex(index));
		assert.ok(back);
		assert.equal(back.modelId, "model-a");
		assert.equal(back.dim, 3);
		assert.deepEqual(back.ids, ["n_a", "n_b"]);
		assert.deepEqual(back.hashes, ["ha", "hb"]);
		assert.deepEqual(Array.from(back.vectors), Array.from(index.vectors));
	});

	it("an empty index round-trips too", () => {
		const back = decodeIndex(encodeIndex(emptyIndex({ id: "m", dim: 4 })));
		assert.ok(back);
		assert.equal(back.ids.length, 0);
	});

	it("rejects truncated, garbage and inconsistent bytes with null (never a partial index)", () => {
		const bytes = encodeIndex(indexOf([{ id: "n_a", hash: "ha", vector: vec(1, 2, 3) }]));
		assert.equal(decodeIndex(bytes.slice(0, bytes.length - 4)), null);
		assert.equal(decodeIndex(new Uint8Array([1, 2, 3])), null);
		assert.equal(decodeIndex(new TextEncoder().encode("not an index at all, just text")), null);
	});
});

describe("rankIndex", () => {
	it("ranks every row by similarity to the query, best first", () => {
		const index = indexOf([
			{ id: "n_far", hash: "1", vector: vec(0, 1, 0) },
			{ id: "n_near", hash: "2", vector: vec(1, 0.1, 0) },
		]);
		assert.deepEqual(
			rankIndex(index, vec(1, 0, 0)).map((h) => h.id),
			["n_near", "n_far"],
		);
	});
});

describe("store (atomic file in the data directory)", () => {
	function freshDir(): string {
		const root = mkdtempSync(join(tmpdir(), "ext-vector-index-"));
		roots.push(root);
		mkdirSync(join(root, "ext"), { recursive: true });
		return root;
	}

	it("the index file lives under ext/ and reads back equal to what was written", () => {
		const dir = freshDir();
		const file = vectorIndexPath(dir);
		assert.equal(file, join(dir, "ext", "embeddings.bin"));
		assert.equal(readVectorIndex(file), null, "a missing file reads as null");
		const index = indexOf([{ id: "n_a", hash: "ha", vector: vec(1, 2, 3) }]);
		writeVectorIndex(file, index);
		const back = readVectorIndex(file);
		assert.ok(back);
		assert.deepEqual(back.ids, ["n_a"]);
		assert.deepEqual(Array.from(back.vectors), [1, 2, 3]);
	});

	it("a failed write leaves the previous complete index in place and no temp file behind a reader", () => {
		const dir = freshDir();
		const file = vectorIndexPath(dir);
		writeVectorIndex(file, indexOf([{ id: "n_old", hash: "h", vector: vec(1, 0, 0) }]));
		const realRename = fs.renameSync;
		fs.renameSync = () => {
			throw new Error("simulated crash before rename");
		};
		try {
			assert.throws(() => writeVectorIndex(file, indexOf([{ id: "n_new", hash: "h", vector: vec(0, 1, 0) }])), /simulated crash/);
		} finally {
			fs.renameSync = realRename;
		}
		assert.deepEqual(readVectorIndex(file)?.ids, ["n_old"]);
		// Readers only look at the named file; a leftover temp is never read as an index.
		assert.ok(readdirSync(join(dir, "ext")).every((n) => n === "embeddings.bin" || n.includes(".tmp-")));
	});

	it("a corrupt file reads as null, so the caller rebuilds", () => {
		const dir = freshDir();
		const file = vectorIndexPath(dir);
		fs.writeFileSync(file, "garbage");
		assert.equal(readVectorIndex(file), null);
	});
});
