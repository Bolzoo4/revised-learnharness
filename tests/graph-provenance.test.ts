/**
 * Multi-source provenance with page anchors (graph-provenance).
 *
 * A node keeps EVERY source that asserted it: a re-encounter (the auditor's
 * link verdict) appends the new source's point, equal points never repeat,
 * and a document point may carry an optional page (integer >= 1) and passage
 * (truncated to 300 characters). Anchorless points stay valid.
 *
 * The merger runs against an in-memory GraphStore (the port); the store's
 * read guards run against the real fs adapter, with the nodes ledger backed
 * up and restored (same discipline as tests/graph.test.ts). The MCP view is
 * exercised through getNode with a stubbed Call.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import type { AuditVerdicts, GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { getGraph, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import type { Call } from "../src/core/ext/mcp/call.ts";
import { getNode } from "../src/core/ext/mcp/node.ts";
import { graphStore as fsGraphStore } from "../src/store/graph.ts";
import { LEDGER_FILES } from "../config.ts";
import { NOTES_EXTRACTOR_INSTRUCTIONS } from "../src/agent/subagents/extraction.ts";

const T0 = "2026-11-20T10:00:00.000Z";

/** An in-memory GraphStore: only the methods the merger and the derivation touch. */
function memoryStore(seed: { nodes?: GraphNode[]; chains?: GraphChain[] } = {}) {
	const nodes: GraphNode[] = [...(seed.nodes ?? [])];
	const chains: GraphChain[] = [...(seed.chains ?? [])];
	const store = {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n, provenance: [...n.provenance] })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, provenance: [...c.provenance] })),
		rewriteLedgers: () => {},
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: () => {},
		readCoverage: () => [],
	};
	return store;
}

const deps = (store: ReturnType<typeof memoryStore>) => ({ chatStore: undefined as never, graphStore: store as unknown as GraphStore }) as GraphDeps;
const noVerdicts: AuditVerdicts = { links: [] };

function findings(propositions: SessionFindings["propositions"]): SessionFindings {
	return { propositions, chains: [] };
}

const prop = (over: Partial<SessionFindings["propositions"][number]> = {}) => ({
	id: "p1",
	name: "Entropy",
	statement: "Entropy measures disorder.",
	aliases: [],
	...over,
});

/** The provenance of the node with this statement, read back through the real derivation. */
function provenanceOf(store: ReturnType<typeof memoryStore>, statement: string) {
	const node = getGraph(store).nodes.find((n) => n.statement === statement);
	assert.ok(node, `node "${statement}" should exist`);
	return node.provenance;
}

describe("merge appends the new source to an existing node", () => {
	it("a link verdict adds the second source's point; both survive in getGraph", () => {
		const store = memoryStore();
		mergeFindings("chat_a", findings([prop({ messageId: "m1" })]), noVerdicts, deps(store), { foldedAt: T0 });
		const existing = getGraph(store).nodes[0]!.id;
		mergeFindings(
			"src_book",
			findings([prop({ id: "p1", messageId: "" , page: 3 } as never)]),
			{ links: [{ id: "p1", linkTo: existing }] },
			deps(store),
			{ foldedAt: T0 },
		);
		const provenance = provenanceOf(store, "Entropy measures disorder.");
		assert.deepEqual(provenance, [
			{ chatId: "chat_a", messageId: "m1" },
			{ chatId: "src_book", messageId: "", page: 3 },
		]);
	});
});

describe("no equal entry is ever repeated", () => {
	it("the same source point merged twice yields one provenance entry", () => {
		const store = memoryStore();
		const doc = prop({ page: 4, passage: "Entropy is a measure of disorder." } as never);
		mergeFindings("src_book", findings([doc as never]), noVerdicts, deps(store), { foldedAt: T0 });
		const id = getGraph(store).nodes[0]!.id;
		const again = { links: [{ id: "p1", linkTo: id }] };
		mergeFindings("src_book", findings([doc as never]), again, deps(store), { foldedAt: T0 });
		mergeFindings("src_book", findings([doc as never]), again, deps(store), { foldedAt: T0 });
		assert.equal(provenanceOf(store, "Entropy measures disorder.").length, 1);
	});

	it("the same chat and message with a different page is a different entry", () => {
		const store = memoryStore();
		mergeFindings("src_book", findings([prop({ page: 4 } as never)]), noVerdicts, deps(store), { foldedAt: T0 });
		const id = getGraph(store).nodes[0]!.id;
		mergeFindings("src_book", findings([prop({ page: 9 } as never)]), { links: [{ id: "p1", linkTo: id }] }, deps(store), { foldedAt: T0 });
		assert.equal(provenanceOf(store, "Entropy measures disorder.").length, 2);
	});
});

describe("document anchors: page and passage", () => {
	it("a page and a passage are kept on the provenance entry", () => {
		const store = memoryStore();
		mergeFindings("src_book", findings([prop({ page: 12, passage: "Entropy measures disorder." } as never)]), noVerdicts, deps(store), {
			foldedAt: T0,
		});
		assert.deepEqual(provenanceOf(store, "Entropy measures disorder."), [
			{ chatId: "src_book", messageId: "", page: 12, passage: "Entropy measures disorder." },
		]);
	});

	it("a passage longer than 300 characters is truncated to 300", () => {
		const store = memoryStore();
		const long = "x".repeat(450);
		mergeFindings("src_book", findings([prop({ page: 1, passage: long } as never)]), noVerdicts, deps(store), { foldedAt: T0 });
		const [point] = provenanceOf(store, "Entropy measures disorder.");
		assert.equal((point as { passage?: string }).passage?.length, 300);
	});

	it("an invalid page (zero, fractional, or not a number) is dropped, not stored", () => {
		for (const page of [0, 2.5, "7"]) {
			const store = memoryStore();
			mergeFindings("src_book", findings([prop({ page } as never)]), noVerdicts, deps(store), { foldedAt: T0 });
			const [point] = provenanceOf(store, "Entropy measures disorder.");
			assert.equal("page" in (point as object), false, `page ${String(page)} must not be stored`);
		}
	});

	it("an anchorless entry (legacy shape) stays valid and reads back unchanged", () => {
		const legacy: GraphNode = {
			id: "n_legacy",
			name: "Entropy",
			statement: "Entropy measures disorder.",
			aliases: [],
			createdAt: T0,
			provenance: [{ chatId: "chat_a", messageId: "m1" }],
		};
		const store = memoryStore({ nodes: [legacy] });
		assert.deepEqual(provenanceOf(store, "Entropy measures disorder."), [{ chatId: "chat_a", messageId: "m1" }]);
	});
});

describe("the real fs store accepts anchored and anchorless points", () => {
	const file = LEDGER_FILES.nodes;
	const bak = `${file}.provenance.bak`;
	const hadFile = fs.existsSync(file);
	if (hadFile) fs.renameSync(file, bak);

	after(() => {
		try {
			fs.unlinkSync(file);
		} catch {
			/* nothing was written */
		}
		if (hadFile) fs.renameSync(bak, file);
	});

	it("readNodes keeps a page-anchored line and a legacy line", () => {
		const anchored: GraphNode = {
			id: "n_anchored",
			name: "Anchored",
			statement: "An anchored statement.",
			aliases: [],
			createdAt: T0,
			provenance: [{ chatId: "src_book", messageId: "", page: 5, passage: "quote" }],
		};
		const legacy: GraphNode = { ...anchored, id: "n_plain", provenance: [{ chatId: "chat_a", messageId: "m2" }] };
		fsGraphStore.appendNode(anchored);
		fsGraphStore.appendNode(legacy);
		const read = fsGraphStore.readNodes();
		assert.equal(read.length, 2);
		assert.deepEqual(read[0]!.provenance, [{ chatId: "src_book", messageId: "", page: 5, passage: "quote" }]);
		assert.deepEqual(read[1]!.provenance, [{ chatId: "chat_a", messageId: "m2" }]);
	});
});

describe("the extraction prompt asks for document anchors", () => {
	it("the notes instructions ask for page and passage when page markers are present", () => {
		assert.match(NOTES_EXTRACTOR_INSTRUCTIONS, /--- Page N ---/);
		assert.match(NOTES_EXTRACTOR_INSTRUCTIONS, /\bpage\b/);
		assert.match(NOTES_EXTRACTOR_INSTRUCTIONS, /\bpassage\b/);
	});
});

describe("get_node returns every provenance entry with its anchors", () => {
	it("lists all points, anchored and anchorless, in order", () => {
		const node: GraphNode = {
			id: "n_a",
			name: "Entropy",
			statement: "Entropy measures disorder.",
			aliases: [],
			createdAt: T0,
			provenance: [
				{ chatId: "chat_a", messageId: "m1" },
				{ chatId: "src_book", messageId: "", page: 3, passage: "p" },
				{ chatId: "src_notes", messageId: "", page: 7 },
			],
		};
		const store = memoryStore({ nodes: [node] });
		const empty = { list: () => [], readAll: () => [], readEvents: () => [], citing: () => null };
		const call = {
			deps: { verification: empty, lectures: empty, explanations: empty, sources: { labels: () => new Map() } },
			now: T0,
			graph: store,
			review: { goalsStore: empty, cardsStore: empty, reviewStore: empty, now: () => new Date(T0) },
		} as unknown as Call;
		const view = getNode(call, { id: "n_a" }, { knowledgeOnly: true }) as unknown as {
			provenance: { items: Array<{ chatId: string; messageId: string; page: number | null; passage: string | null; sourceLabel: string | null }>; truncated: boolean };
		};
		assert.equal(view.provenance.truncated, false);
		assert.deepEqual(view.provenance.items, [
			{ chatId: "chat_a", messageId: "m1", page: null, passage: null, sourceLabel: null },
			{ chatId: "src_book", messageId: "", page: 3, passage: "p", sourceLabel: null },
			{ chatId: "src_notes", messageId: "", page: 7, passage: null, sourceLabel: null },
		]);
	});
});
