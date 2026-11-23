// tests/ext-mcp-query-embedder.test.ts
// The read-only server's query embedder (REQ-search-09, REQ-mcp-01): the query is embedded by the running app through
// AppApiPort.embedQuery, never by a model in this process. A fake appApi stands in for the app; the index is a real file.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { GraphNode } from "../src/core/contracts.ts";
import { EMBEDDINGGEMMA_SPEC, DEFAULT_EMBEDDER_SPEC, type EmbedderSpec } from "../src/core/ext/embedder.ts";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import type { AppApiPort, AppEmbedQueryResult, McpDeps } from "../src/core/ext/mcp/ports.ts";
import { runTool } from "../src/core/ext/mcp/tools.ts";
import { applyUpdate, emptyIndex, indexText } from "../src/core/ext/vector-index.ts";
import { appQueryEmbedder } from "../src/server/ext/mcp/app-embedder.ts";
import { createSemanticReader } from "../src/server/ext/mcp/semantic.ts";
import { createMcpDeps } from "../src/server/ext/mcp/deps.ts";
import { vectorIndexPath, writeVectorIndex } from "../src/server/ext/vector-index-store.ts";
import { createFakeEmbedder, type FakeEmbedder } from "./helpers/fake-embedder.ts";

const roots: string[] = [];
after(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const SPEC: EmbedderSpec = { ...EMBEDDINGGEMMA_SPEC, dim: 256 };
const T0 = "2026-10-01T10:00:00.000Z";
const NOW = "2026-11-06T10:00:00.000Z";
const SYNONYMS = { warmth: "heat" };
const HEAT: GraphNode = { id: "n_heat", name: "Heat transfer", statement: "Heat moves by conduction.", aliases: [], createdAt: T0, provenance: [] };
const OHM: GraphNode = { id: "n_ohm", name: "Ohm", statement: "Voltage equals current times resistance.", aliases: [], createdAt: T0, provenance: [] };

function fake(spec: EmbedderSpec = SPEC): FakeEmbedder {
	return createFakeEmbedder({ dim: spec.dim, spec, synonyms: SYNONYMS });
}

/** An appApi whose embedQuery answers with `fake`'s query vector (or the given override). Every other method refuses. */
function appApiWith(embedder: FakeEmbedder, override?: () => Promise<AppEmbedQueryResult>): AppApiPort & { queries: string[] } {
	const queries: string[] = [];
	const noWrite = () => {
		throw new Error("write attempted in a read-only test");
	};
	return {
		queries,
		post: noWrite,
		put: noWrite,
		get: noWrite,
		async embedQuery(text: string) {
			queries.push(text);
			if (override) return override();
			const v = (await embedder.embed([text], "query"))[0]!;
			return { vector: Array.from(v), modelId: SPEC.id, dim: SPEC.dim };
		},
	};
}

/** A fresh data directory's index path (the file is written by writeIndex). */
function indexFile(): string {
	const root = mkdtempSync(join(tmpdir(), "ext-mcp-query-"));
	roots.push(root);
	mkdirSync(join(root, "ext"), { recursive: true });
	return vectorIndexPath(root);
}

async function writeIndex(file: string, nodes: GraphNode[], embedder: FakeEmbedder, spec: EmbedderSpec): Promise<void> {
	// The index file's documents are embedded with the same fake model that answers the queries.
	const vectors = await embedder.embed(nodes.map((n) => indexText(n)), "document");
	const index = applyUpdate(emptyIndex({ id: spec.id, dim: spec.dim }), {
		upserts: nodes.map((n, i) => ({ id: n.id, hash: n.id, vector: vectors[i]! })),
		drop: [],
	});
	writeVectorIndex(file, index);
}

/** The McpDeps that search_nodes needs, with the given semantic port. */
function depsWith(nodes: GraphNode[], semantic: McpDeps["semantic"], appApi: AppApiPort): McpDeps {
	const noWrite = () => {
		throw new Error("write attempted in a read-only test");
	};
	const empty = { readAll: () => [] as unknown[], readEvents: () => [] as unknown[] };
	return {
		appApi,
		sources: { labels: () => new Map<string, string>() },
		review: {
			graphStore: { readNodes: () => nodes, readChains: () => [] },
			goalsStore: { ...empty, appendEvent: noWrite },
			reviewStore: { ...empty, appendEvent: noWrite },
			cardsStore: { ...empty, appendEvent: noWrite },
			linksStore: { readLinks: () => [] },
			now: () => NOW,
		},
		verification: { readAll: () => [] },
		explanations: { readAll: () => [] },
		exercises: { readAll: () => [] },
		frontier: { readAll: () => [] },
		inbox: { readAll: () => [] },
		researchLog: { readAll: () => [] },
		journal: { readAll: () => [] },
		documents: { readAll: () => [] },
		reading: { readAll: () => [] },
		lectures: { get: () => null, list: () => [], citing: () => [] },
		semantic,
		now: () => NOW,
		assertReadable: () => undefined,
	} as unknown as McpDeps;
}

describe("appQueryEmbedder: the query goes to the app", () => {
	it("embeds one query by asking the app, and returns its vector as Float32Array", async () => {
		const f = fake();
		const app = appApiWith(f);
		const load = await appQueryEmbedder(app, SPEC)();
		assert.ok(load.ok);
		const [vector] = await load.embedder.embed(["warmth"], "query");
		assert.ok(vector instanceof Float32Array);
		assert.equal(vector.length, SPEC.dim);
		assert.deepEqual(app.queries, ["warmth"]);
	});

	it("refuses a document embedding: the server only asks the app for queries", async () => {
		const load = await appQueryEmbedder(appApiWith(fake()), SPEC)();
		assert.ok(load.ok);
		await assert.rejects(load.embedder.embed(["text"], "document"), /query/);
	});

	it("refuses an answer from another model or dimension as stale, and never uses its vector", async () => {
		const other = appApiWith(fake(), async () => ({ vector: new Array(SPEC.dim).fill(0.1), modelId: "other/model", dim: SPEC.dim }));
		const load = await appQueryEmbedder(other, SPEC)();
		assert.ok(load.ok);
		await assert.rejects(load.embedder.embed(["warmth"], "query"), (e: unknown) => e instanceof ToolError && e.code === "app_rejected" && /stale/.test(e.message));

		const wideDim = appApiWith(fake(), async () => ({ vector: new Array(SPEC.dim * 2).fill(0.1), modelId: SPEC.id, dim: SPEC.dim * 2 }));
		const load2 = await appQueryEmbedder(wideDim, SPEC)();
		assert.ok(load2.ok);
		await assert.rejects(load2.embedder.embed(["warmth"], "query"), (e: unknown) => e instanceof ToolError && /stale/.test(e.message));
	});
});

describe("the semantic port over the app's embedder", () => {
	it("ranks the index by the app's query vector: a paraphrase finds the node", async () => {
		const f = fake();
		const file = indexFile();
		await writeIndex(file, [HEAT, OHM], f, SPEC);
		const port = createSemanticReader(file, SPEC, appQueryEmbedder(appApiWith(f), SPEC));
		const out: any = await runTool("search_nodes", depsWith([HEAT, OHM], port, appApiWith(f)), { query: "warmth", mode: "semantic" }, { knowledgeOnly: false });
		assert.equal(out.mode, "semantic");
		assert.equal(out.items[0].id, "n_heat");
		assert.equal(out.note, undefined);
	});

	it("when the app is not running, the note says why and the answer is the keyword answer", async () => {
		const f = fake();
		const file = indexFile();
		await writeIndex(file, [HEAT, OHM], f, SPEC);
		const unreachable = appApiWith(f, async () => {
			throw new ToolError("app_unreachable", "the LearnHarness app is not running or not paired; start it and try again.");
		});
		const port = createSemanticReader(file, SPEC, appQueryEmbedder(unreachable, SPEC));
		const out: any = await runTool("search_nodes", depsWith([HEAT, OHM], port, unreachable), { query: "ohm", mode: "hybrid" }, { knowledgeOnly: false });
		assert.equal(out.mode, "keyword");
		assert.match(out.note, /^semantic search unavailable: the LearnHarness app is not running or not paired/);
	});

	it("when the app has no model, its unavailable reason reaches the note", async () => {
		const f = fake();
		const file = indexFile();
		await writeIndex(file, [HEAT], f, SPEC);
		const noModel = appApiWith(f, async () => {
			throw new ToolError("app_rejected", "unavailable: model not downloaded");
		});
		const port = createSemanticReader(file, SPEC, appQueryEmbedder(noModel, SPEC));
		const out: any = await runTool("search_nodes", depsWith([HEAT], port, noModel), { query: "warmth", mode: "semantic" }, { knowledgeOnly: false });
		assert.equal(out.mode, "keyword");
		assert.equal(out.note, "semantic search unavailable: unavailable: model not downloaded");
	});

	it("an index built by another model is refused before the app is asked for anything", async () => {
		const f = fake();
		const file = indexFile();
		await writeIndex(file, [HEAT], f, { ...SPEC, id: "other/model" });
		const app = appApiWith(f);
		const port = createSemanticReader(file, SPEC, appQueryEmbedder(app, SPEC));
		const out: any = await runTool("search_nodes", depsWith([HEAT], port, app), { query: "warmth", mode: "semantic" }, { knowledgeOnly: false });
		assert.equal(out.mode, "keyword");
		assert.match(out.note, /built by another model/);
		assert.deepEqual(app.queries, [], "no query was sent to the app");
	});
});

describe("createMcpDeps wires the query embedder to appApi", () => {
	it("the default semantic port asks the app for the query vector, not a local model", async () => {
		const root = mkdtempSync(join(tmpdir(), "ext-mcp-deps-"));
		roots.push(root);
		mkdirSync(join(root, "ext"), { recursive: true });
		const f = createFakeEmbedder({ dim: DEFAULT_EMBEDDER_SPEC.dim, spec: DEFAULT_EMBEDDER_SPEC, synonyms: SYNONYMS });
		const vectors = await f.embed([indexText(HEAT)], "document");
		writeVectorIndex(
			vectorIndexPath(root),
			applyUpdate(emptyIndex({ id: DEFAULT_EMBEDDER_SPEC.id, dim: DEFAULT_EMBEDDER_SPEC.dim }), {
				upserts: [{ id: HEAT.id, hash: HEAT.id, vector: vectors[0]! }],
				drop: [],
			}),
		);
		const queries: string[] = [];
		const app: AppApiPort = {
			post: async () => {
				throw new Error("not used");
			},
			put: async () => {
				throw new Error("not used");
			},
			get: async () => {
				throw new Error("not used");
			},
			async embedQuery(text: string) {
				queries.push(text);
				const v = (await f.embed([text], "query"))[0]!;
				return { vector: Array.from(v), modelId: DEFAULT_EMBEDDER_SPEC.id, dim: DEFAULT_EMBEDDER_SPEC.dim };
			},
		};
		const deps = createMcpDeps(root, () => NOW, app);
		const state = await deps.semantic!.load();
		assert.equal(state.ok, true);
		if (!state.ok) return;
		const q = await state.embedQuery("warmth");
		assert.equal(q.length, DEFAULT_EMBEDDER_SPEC.dim);
		assert.deepEqual(queries, ["warmth"]);
	});
});
