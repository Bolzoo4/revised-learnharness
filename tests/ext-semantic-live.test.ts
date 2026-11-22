// tests/ext-semantic-live.test.ts
// The app-side index maintenance (REQ-search-07, 09): incremental refresh, debounce, failure handling. Uses the
// deterministic fake embedder; no model is loaded.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { GraphNode } from "../src/core/contracts.ts";
import { EMBEDDINGGEMMA_SPEC } from "../src/core/ext/embedder.ts";
import { createSemanticIndexer, unavailableEmbedder, type EmbedderLoad } from "../src/server/ext/semantic-indexer.ts";
import { createLiveSemanticIndexer } from "../src/server/ext/semantic-live.ts";
import { readVectorIndex, vectorIndexPath } from "../src/server/ext/vector-index-store.ts";
import { createFakeEmbedder, type FakeEmbedder } from "./helpers/fake-embedder.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const SPEC = { ...EMBEDDINGGEMMA_SPEC, dim: 16 };

function gnode(id: string, name: string, statement: string, aliases: string[] = []): GraphNode {
	return { id, name, statement, aliases, createdAt: "2026-11-01T10:00:00.000Z", provenance: [] };
}

function freshFile(): string {
	const root = mkdtempSync(join(tmpdir(), "ext-semantic-live-"));
	roots.push(root);
	mkdirSync(join(root, "ext"), { recursive: true });
	return vectorIndexPath(root);
}

/** A mutable node list plus a loader that counts how often it is asked for an embedder. */
function harness(debounceMs = 5) {
	const file = freshFile();
	const fake: FakeEmbedder = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC });
	let nodes: GraphNode[] = [];
	let loads = 0;
	let load: () => Promise<EmbedderLoad> = async () => ({ ok: true, embedder: fake });
	const indexer = createSemanticIndexer({
		file,
		spec: SPEC,
		readNodes: () => nodes,
		loadEmbedder: () => {
			loads++;
			return load();
		},
		debounceMs,
	});
	return {
		file,
		fake,
		indexer,
		setNodes(next: GraphNode[]) {
			nodes = next;
		},
		setLoad(next: () => Promise<EmbedderLoad>) {
			load = next;
		},
		get loads() {
			return loads;
		},
	};
}

const A = gnode("n_a", "Entropy", "Entropy never decreases in an isolated system.");
const B = gnode("n_b", "Heat", "Heat flows from hot to cold bodies.");
const C = gnode("n_c", "Priors", "A prior encodes belief before seeing data.", ["prior belief"]);
const D = gnode("n_d", "Ohm", "Voltage equals current times resistance.");
const E = gnode("n_e", "Gibbs", "Free energy decides spontaneity.");

describe("createSemanticIndexer (incremental refresh)", () => {
	it("adding three nodes embeds exactly those three", async () => {
		const h = harness();
		h.setNodes([A, B]);
		assert.equal((await h.indexer.refresh()).embedded, 2);
		const before = h.fake.seen.length;
		h.setNodes([A, B, C, D, E]);
		const report = await h.indexer.refresh();
		assert.equal(report.status, "updated");
		assert.equal(report.embedded, 3);
		assert.equal(h.fake.seen.length - before, 3);
		assert.deepEqual(readVectorIndex(h.file)?.ids, ["n_a", "n_b", "n_c", "n_d", "n_e"]);
	});

	it("an unchanged node is not embedded again", async () => {
		const h = harness();
		h.setNodes([A, B]);
		await h.indexer.refresh();
		const before = h.fake.seen.length;
		const report = await h.indexer.refresh();
		assert.equal(report.status, "unchanged");
		assert.equal(h.fake.seen.length, before);
		assert.equal(h.loads, 1, "no embedder is loaded when nothing changed");
	});

	it("a node whose text changed is embedded again, and only that one", async () => {
		const h = harness();
		h.setNodes([A, B]);
		await h.indexer.refresh();
		const before = h.fake.seen.length;
		h.setNodes([A, { ...B, aliases: ["thermal flow"] }]);
		const report = await h.indexer.refresh();
		assert.equal(report.embedded, 1);
		assert.equal(h.fake.seen.length - before, 1);
	});

	it("deleting a node drops its vector", async () => {
		const h = harness();
		h.setNodes([A, B]);
		await h.indexer.refresh();
		h.setNodes([A]);
		const report = await h.indexer.refresh();
		assert.equal(report.dropped, 1);
		assert.deepEqual(readVectorIndex(h.file)?.ids, ["n_a"]);
	});

	it("the index file exists on disk after the first update", async () => {
		const h = harness();
		assert.equal(existsSync(h.file), false);
		h.setNodes([A]);
		await h.indexer.refresh();
		assert.equal(existsSync(h.file), true);
	});

	it("overlapping refreshes run one after another, so the second sees the first's result", async () => {
		const h = harness();
		h.setNodes([A, B]);
		const [r1, r2] = await Promise.all([h.indexer.refresh(), h.indexer.refresh()]);
		assert.equal(r1.status, "updated");
		assert.equal(r2.status, "unchanged");
		assert.equal(h.fake.seen.length, 2);
	});
});

describe("createSemanticIndexer (debounce)", () => {
	it("several schedule calls inside the window run one refresh", async () => {
		const h = harness(30);
		h.setNodes([A, B]);
		h.indexer.schedule();
		h.indexer.schedule();
		h.indexer.schedule();
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(h.loads, 1);
		assert.deepEqual(readVectorIndex(h.file)?.ids, ["n_a", "n_b"]);
		h.indexer.dispose();
	});

	it("dispose cancels a pending refresh", async () => {
		const h = harness(30);
		h.setNodes([A]);
		h.indexer.schedule();
		h.indexer.dispose();
		await new Promise((r) => setTimeout(r, 90));
		assert.equal(h.loads, 0);
		assert.equal(existsSync(h.file), false);
	});
});

describe("createSemanticIndexer (failures leave the previous index)", () => {
	it("an embedder failure keeps the previous index and records the error", async () => {
		const h = harness();
		h.setNodes([A]);
		await h.indexer.refresh();
		const failing = createFakeEmbedder({ dim: SPEC.dim, spec: SPEC, fail: new Error("model crashed") });
		h.setLoad(async () => ({ ok: true, embedder: failing }));
		h.setNodes([A, B]);
		const report = await h.indexer.refresh();
		assert.equal(report.status, "failed");
		assert.match(report.reason ?? "", /model crashed/);
		assert.match(h.indexer.status().lastError ?? "", /model crashed/);
		assert.deepEqual(readVectorIndex(h.file)?.ids, ["n_a"], "the file still holds the previous index");
	});

	it("a missing model reports the unavailable reason and writes nothing", async () => {
		const h = harness();
		h.setLoad(unavailableEmbedder);
		h.setNodes([A]);
		const report = await h.indexer.refresh();
		assert.equal(report.status, "failed");
		assert.equal(report.reason, "unavailable: model not downloaded");
		assert.equal(h.indexer.status().lastError, "unavailable: model not downloaded");
		assert.equal(existsSync(h.file), false);
	});

	it("a later success clears the recorded error", async () => {
		const h = harness();
		h.setLoad(unavailableEmbedder);
		h.setNodes([A]);
		await h.indexer.refresh();
		h.setLoad(async () => ({ ok: true, embedder: h.fake }));
		await h.indexer.refresh();
		assert.equal(h.indexer.status().lastError, null);
		assert.notEqual(h.indexer.status().lastRefreshAt, null);
	});

	it("an embedder for another model is refused, never mixed into the index", async () => {
		const h = harness();
		const other = createFakeEmbedder({ dim: SPEC.dim, spec: { ...SPEC, id: "some/other-model" } });
		h.setLoad(async () => ({ ok: true, embedder: other }));
		h.setNodes([A]);
		const report = await h.indexer.refresh();
		assert.equal(report.status, "failed");
		assert.equal(existsSync(h.file), false);
	});
});

describe("the production wiring (createLiveSemanticIndexer)", () => {
	it("with no model in the cache, a refresh reports the not-downloaded reason and writes nothing", async () => {
		const file = freshFile();
		const cacheDir = join(file, "..", "..", "empty-models");
		const indexer = createLiveSemanticIndexer({ file, readNodes: () => [A, B], cacheDir, debounceMs: 5 });
		const report = await indexer.refresh();
		assert.equal(report.status, "failed");
		assert.equal(report.reason, "unavailable: model not downloaded");
		assert.equal(existsSync(file), false);
		assert.equal(existsSync(cacheDir), false, "the cache is never created or written by a refresh");
		indexer.dispose();
	});
});
