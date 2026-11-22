// tests/ext-mcp-semantic-search.test.ts
// search_nodes modes (REQ-search-08), the stage filter in every mode, and suggest_links (REQ-search-10).
// The semantic index is an in-memory fake built with the deterministic fake embedder: no model, no file.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { EMBEDDINGGEMMA_SPEC } from "../src/core/ext/embedder.ts";
import type { Link } from "../src/core/ext/links.ts";
import type { McpDeps, SemanticPort, SemanticState } from "../src/core/ext/mcp/ports.ts";
import { runTool } from "../src/core/ext/mcp/tools.ts";
import { applyUpdate, emptyIndex, indexText, type VectorIndex } from "../src/core/ext/vector-index.ts";
import { createFakeEmbedder, type FakeEmbedder } from "./helpers/fake-embedder.ts";

const NOW = "2026-11-06T10:00:00.000Z";
const T0 = "2026-10-01T10:00:00.000Z";
const SPEC = { ...EMBEDDINGGEMMA_SPEC, dim: 256 };
const OPTS = { knowledgeOnly: false };

function gnode(id: string, name: string, statement: string, aliases: string[] = []): GraphNode {
	return { id, name, statement, aliases, createdAt: T0, provenance: [] };
}

function chain(id: string, premises: string[], conclusion: string): GraphChain {
	return { id, premises, conclusion, provenance: [], createdAt: T0 };
}

function link(id: string, from: string, to: string, linkType: Link["linkType"] = "sequence"): Link {
	return { id, from, to, linkType, directed: linkType === "sequence", origin: "user", createdAt: T0 };
}

/** The minimal McpDeps the knowledge tools need: an in-memory graph, links and an optional semantic port. */
function depsFor(opts: { nodes: GraphNode[]; chains?: GraphChain[]; links?: Link[]; semantic?: SemanticPort }): McpDeps {
	const noWrite = () => {
		throw new Error("write attempted in a read-only test");
	};
	const empty = { readAll: () => [] as unknown[], readEvents: () => [] as unknown[] };
	const deps = {
		appApi: {
			post: noWrite,
			put: noWrite,
			get: noWrite,
		},
		sources: { labels: () => new Map<string, string>() },
		review: {
			graphStore: { readNodes: () => opts.nodes, readChains: () => opts.chains ?? [] },
			goalsStore: { ...empty, appendEvent: noWrite },
			reviewStore: { ...empty, appendEvent: noWrite },
			cardsStore: { ...empty, appendEvent: noWrite },
			linksStore: { readLinks: () => opts.links ?? [] }, // no append method: a write would fail
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
		now: () => NOW,
		assertReadable: () => undefined,
		...(opts.semantic ? { semantic: opts.semantic } : {}),
	};
	return deps as unknown as McpDeps;
}

/** A semantic port over an index built from `nodes` with the fake embedder (only the given ids are indexed). */
async function semanticFor(nodes: GraphNode[], fake: FakeEmbedder, indexed: string[] = nodes.map((n) => n.id)): Promise<SemanticPort> {
	const rows = nodes.filter((n) => indexed.includes(n.id));
	const vectors = await fake.embed(
		rows.map((n) => indexText(n)),
		"document",
	);
	let index: VectorIndex = emptyIndex({ id: SPEC.id, dim: SPEC.dim });
	index = applyUpdate(index, {
		upserts: rows.map((n, i) => ({ id: n.id, hash: n.id, vector: vectors[i]! })),
		drop: [],
	});
	const state: SemanticState = {
		ok: true,
		index,
		embedQuery: async (text) => (await fake.embed([text], "query"))[0]!,
	};
	return { load: async () => state };
}

const SYNONYMS = { warmth: "heat", temperature: "heat" };

const HEAT = gnode("n_heat", "Heat transfer", "Heat moves from warmer to cooler bodies by conduction.");
const BAYES = gnode("n_bayes", "Bayes rule", "The posterior is proportional to the likelihood times the prior.");
const ENTROPY = gnode("n_entropy", "Entropy", "Entropy never decreases in an isolated system.");
const ENTROPY2 = gnode("n_entropy2", "Entropy handbook", "A reference overview of entropy in physics.");
const GIBBS = gnode("n_gibbs", "Gibbs", "Free energy decides spontaneity.");
const OHM = gnode("n_ohm", "Ohm", "Voltage equals current times resistance.");

function fake(): FakeEmbedder {
	return createFakeEmbedder({ dim: SPEC.dim, spec: SPEC, synonyms: SYNONYMS });
}

describe("search_nodes modes", () => {
	it("semantic mode ranks a paraphrase first even with no shared words", async () => {
		const nodes = [BAYES, HEAT];
		const f = fake();
		const deps = depsFor({ nodes, semantic: await semanticFor(nodes, f) });
		const out: any = await runTool("search_nodes", deps, { query: "warmth", mode: "semantic" }, OPTS);
		assert.equal(out.mode, "semantic");
		assert.equal(out.items[0].id, "n_heat");
		assert.equal(out.note, undefined, "no fallback note when the semantic index answered");
	});

	it("keyword mode is the old behaviour: no match for the paraphrase, and the semantic port is never touched", async () => {
		let loads = 0;
		const nodes = [HEAT];
		const deps = depsFor({
			nodes,
			semantic: {
				load: async () => {
					loads++;
					throw new Error("keyword mode must not load the index");
				},
			},
		});
		const out: any = await runTool("search_nodes", deps, { query: "warmth", mode: "keyword" }, OPTS);
		assert.equal(out.count, 0);
		assert.equal(out.mode, "keyword");
		assert.equal(loads, 0);
	});

	it("hybrid merges the keyword and semantic rankings: a node first in both comes before one in only one", async () => {
		// WARM matches "warmth" by name (keyword) and by the synonym (semantic); HEAT matches by the synonym only.
		const WARM = gnode("n_warm", "Warmth budget", "Heat budget of a house.");
		const nodes = [HEAT, WARM];
		const deps = depsFor({ nodes, semantic: await semanticFor(nodes, fake()) });
		const out: any = await runTool("search_nodes", deps, { query: "warmth" }, OPTS);
		assert.equal(out.mode, "hybrid", "hybrid is the default");
		assert.deepEqual(
			out.items.map((i: any) => i.id),
			["n_warm", "n_heat"],
		);
	});

	it("hybrid with no index answers with keyword results and says why", async () => {
		const nodes = [ENTROPY, ENTROPY2, OHM];
		const deps = depsFor({ nodes, semantic: { load: async () => ({ ok: false, reason: "unavailable: model not installed" }) } });
		const out: any = await runTool("search_nodes", deps, { query: "entropy" }, OPTS);
		assert.equal(out.mode, "keyword");
		assert.equal(out.count, 2);
		assert.match(out.note, /semantic search unavailable: unavailable: model not installed/);
	});

	it("semantic mode without any semantic port falls back to keyword with a note", async () => {
		const deps = depsFor({ nodes: [ENTROPY] });
		const out: any = await runTool("search_nodes", deps, { query: "entropy", mode: "semantic" }, OPTS);
		assert.equal(out.mode, "keyword");
		assert.equal(out.count, 1);
		assert.match(out.note, /^semantic search unavailable: /);
	});

	it("a query-embedding failure falls back to keyword with a note, never throws", async () => {
		const deps = depsFor({
			nodes: [ENTROPY],
			semantic: {
				load: async () => ({
					ok: true,
					index: emptyIndex({ id: SPEC.id, dim: SPEC.dim }),
					embedQuery: async () => {
						throw new Error("tokenizer crashed");
					},
				}),
			},
		});
		const out: any = await runTool("search_nodes", deps, { query: "entropy", mode: "hybrid" }, OPTS);
		assert.equal(out.mode, "keyword");
		assert.match(out.note, /query embedding failed/);
		assert.equal(out.count, 1);
	});

	it("the stage filter runs before the limit in every mode", async () => {
		// With no review history every node is confirmed, so stage "staged" hides all of them: each mode reports the hidden count.
		const nodes = [ENTROPY, ENTROPY2, HEAT];
		const semantic = await semanticFor(nodes, fake());
		for (const mode of ["keyword", "semantic", "hybrid"]) {
			const deps = depsFor({ nodes, semantic });
			const out: any = await runTool("search_nodes", deps, { query: "entropy", mode, stage: "staged", limit: 1 }, OPTS);
			assert.equal(out.count, 0, `${mode}: nothing is staged`);
			assert.ok(out.hiddenByStage > 0, `${mode}: the hidden matches are counted`);
		}
	});

	it("limit applies after ranking in semantic mode (the top items are the most similar)", async () => {
		const nodes = [HEAT, BAYES, GIBBS, OHM];
		const deps = depsFor({ nodes, semantic: await semanticFor(nodes, fake()) });
		const out: any = await runTool("search_nodes", deps, { query: "warmth", mode: "semantic", limit: 2 }, OPTS);
		assert.equal(out.items.length, 2);
		assert.equal(out.items[0].id, "n_heat");
		assert.equal(out.truncated, true);
	});

	it("an unknown mode is refused as invalid input", async () => {
		await assert.rejects(async () => runTool("search_nodes", depsFor({ nodes: [] }), { query: "x", mode: "fuzzy" }, OPTS), /mode/);
	});
});

describe("synchronous answers when the file alone rules the index out", () => {
	it("an index the port already knows is unusable answers now, not as a promise", () => {
		const deps = depsFor({
			nodes: [ENTROPY],
			semantic: { load: async () => ({ ok: false, reason: "never called" }), unavailable: () => "the semantic index has not been built yet" },
		});
		const out: any = runTool("search_nodes", deps, { query: "entropy" }, OPTS);
		assert.equal(typeof out.then, "undefined");
		assert.equal(out.count, 1);
		assert.match(out.note, /has not been built yet/);
	});
});

describe("suggest_links", () => {
	it("proposes the most similar nodes not yet linked, excluding itself, linked nodes and chain partners", async () => {
		// ENTROPY is linked by a typed link to HEAT and sits in a chain with OHM. Its nearest unlinked neighbour is ENTROPY2.
		const nodes = [ENTROPY, ENTROPY2, HEAT, OHM, GIBBS];
		const deps = depsFor({
			nodes,
			links: [link("l_1", "n_entropy", "n_heat")],
			chains: [chain("arg_1", ["n_entropy"], "n_ohm")],
			semantic: await semanticFor(nodes, fake()),
		});
		const out: any = await runTool("suggest_links", deps, { id: "n_entropy" }, OPTS);
		const ids = out.items.map((i: any) => i.id);
		assert.equal(ids[0], "n_entropy2");
		assert.ok(!ids.includes("n_entropy"), "not itself");
		assert.ok(!ids.includes("n_heat"), "not typed-linked");
		assert.ok(!ids.includes("n_ohm"), "not chain-linked");
		assert.ok(ids.includes("n_gibbs"));
	});

	it("respects the limit", async () => {
		const nodes = [ENTROPY, ENTROPY2, HEAT, OHM, GIBBS, BAYES];
		const deps = depsFor({ nodes, semantic: await semanticFor(nodes, fake()) });
		const out: any = await runTool("suggest_links", deps, { id: "n_entropy", limit: 2 }, OPTS);
		assert.equal(out.items.length, 2);
		assert.equal(out.truncated, true);
	});

	it("creates nothing: the links store has no write method and the answer is read-only", async () => {
		const nodes = [ENTROPY, ENTROPY2];
		const links = [link("l_1", "n_entropy", "n_heat")];
		const deps = depsFor({ nodes: [...nodes, HEAT], links, semantic: await semanticFor([...nodes, HEAT], fake()) });
		await runTool("suggest_links", deps, { id: "n_entropy" }, OPTS);
		const again: any = await runTool("suggest_links", deps, { id: "n_entropy" }, OPTS);
		assert.equal(again.items.length, 1);
		assert.equal(deps.review.linksStore?.readLinks().length, 1, "the link set is unchanged");
	});

	it("an unknown node is not_found", async () => {
		const deps = depsFor({ nodes: [ENTROPY] });
		assert.throws(() => runTool("suggest_links", deps, { id: "n_missing" }, OPTS), /No node with id "n_missing"/);
	});

	it("without an index it answers an empty list with a note", async () => {
		const deps = depsFor({ nodes: [ENTROPY, ENTROPY2] });
		const out: any = await runTool("suggest_links", deps, { id: "n_entropy" }, OPTS);
		assert.deepEqual(out.items, []);
		assert.match(out.note, /semantic suggestions unavailable/);
	});

	it("a node that is not in the index yet gets an empty list with a note", async () => {
		const nodes = [ENTROPY, ENTROPY2];
		const deps = depsFor({ nodes, semantic: await semanticFor(nodes, fake(), ["n_entropy2"]) });
		const out: any = await runTool("suggest_links", deps, { id: "n_entropy" }, OPTS);
		assert.deepEqual(out.items, []);
		assert.match(out.note, /not indexed/);
	});

	it("unknown arguments are refused (the tool stays read-only)", async () => {
		await assert.rejects(async () => runTool("suggest_links", depsFor({ nodes: [ENTROPY] }), { id: "n_entropy", from: "x" }, OPTS), /Unknown argument/);
	});
});
