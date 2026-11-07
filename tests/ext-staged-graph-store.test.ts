import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoverageEntry, ExtractionRunUsage, GraphChain, GraphNode, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { getGraph } from "../src/core/graph.ts";
import { createStagedGraphStore } from "../src/server/ext/staged-graph-store.ts";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name: `name ${id}`,
	statement: `statement ${id}`,
	aliases: [],
	createdAt: "2026-11-07T09:00:00.000Z",
	provenance: [{ chatId: "chat_base", messageId: "" }],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string, chatId = "src_chapter"): GraphChain => ({
	id,
	premises,
	conclusion,
	createdAt: "2026-11-07T09:00:00.000Z",
	provenance: [{ chatId, messageId: "" }],
});
const usage = (startedAt: string): ExtractionRunUsage => ({
	startedAt,
	at: startedAt,
	durationMs: 1,
	stages: { extractor: { model: "m", steps: [] }, auditor: { model: "m", steps: [] } },
});

/** A complete in-memory base store; every write is recorded so the replay order can be checked. */
function memBase(seed: { nodes?: GraphNode[]; chains?: GraphChain[]; sources?: NotesSource[] } = {}) {
	let nodes: GraphNode[] = [...(seed.nodes ?? [])];
	let chains: GraphChain[] = [...(seed.chains ?? [])];
	let coverage: CoverageEntry[] = [];
	let checkpoints: SessionCheckpoint[] = [];
	let sources: NotesSource[] = [...(seed.sources ?? [])];
	let positions: Record<string, { x: number; y: number }> = {};
	const log: string[] = [];
	const store: GraphStore = {
		appendNode: (n) => (log.push(`node:${n.id}`), nodes.push(n)),
		readNodes: () => [...nodes],
		appendChain: (c) => (log.push(`chain:${c.id}`), chains.push(c)),
		readChains: () => [...chains],
		appendCheckpoint: (c) => (log.push("checkpoint"), checkpoints.push(c)),
		readCheckpoints: () => [...checkpoints],
		appendCoverage: (c) => (log.push("coverage"), coverage.push(c)),
		readCoverage: () => [...coverage],
		upsertSource: (s) => {
			log.push(`source:${s.id}`);
			const prev = sources.find((x) => x.id === s.id);
			sources = [...sources.filter((x) => x.id !== s.id), prev ? { ...s, extractions: prev.extractions } : s];
		},
		readSources: () => [...sources],
		deleteSources: () => 0,
		appendSourceUsage: (id, entry) => {
			log.push(`usage:${id}`);
			sources = sources.map((s) => (s.id === id ? { ...s, extractions: [...(s.extractions ?? []), entry] } : s));
		},
		readPositions: () => ({ ...positions }),
		writePositions: (p) => void (positions = { ...p }),
		rewriteLedgers: (next) => {
			if (next.nodes) nodes = [...next.nodes];
			if (next.chains) chains = [...next.chains];
			if (next.coverage) coverage = [...next.coverage];
			if (next.checkpoints) checkpoints = [...next.checkpoints];
		},
	};
	return { store, log, snapshot: () => JSON.stringify({ nodes, chains, coverage, checkpoints, sources, positions }), nodesNow: () => nodes, chainsNow: () => chains, sourcesNow: () => sources };
}

describe("staged graph store: reads", () => {
	it("reads return the base followed by the staged writes, for every ledger", () => {
		const base = memBase({ nodes: [node("n_base")], chains: [chain("arg_base", ["n_base"], "n_base", "chat_base")], sources: [{ id: "src_base", filePath: "/a.txt", importedAt: "t" }] });
		base.store.appendCoverage({ chatId: "chat_base", messageId: "m1", fingerprint: "f" } as CoverageEntry);
		const s = createStagedGraphStore(base.store);
		s.appendNode(node("n_new"));
		s.appendChain(chain("arg_new", ["n_new"], "n_base", "src_chapter"));
		s.appendCoverage({ chatId: "src_chapter", messageId: "m2", fingerprint: "g" } as CoverageEntry);
		s.appendCheckpoint({ chatId: "src_chapter", foldedAt: "t" } as SessionCheckpoint);
		s.upsertSource({ id: "src_chapter", filePath: "/c.txt", importedAt: "t2" });
		assert.deepEqual(s.readNodes().map((n) => n.id), ["n_base", "n_new"]);
		assert.deepEqual(s.readChains().map((c) => c.id), ["arg_base", "arg_new"]);
		assert.equal(s.readCoverage().length, 2);
		assert.equal(s.readCheckpoints().length, 1);
		assert.deepEqual(s.readSources().map((x) => x.id).sort(), ["src_base", "src_chapter"]);
	});
	it("a staged source keeps the base record's usage log on upsert, and staged usage shows in the view", () => {
		const base = memBase({ sources: [{ id: "src_x", filePath: "/x.txt", importedAt: "t0", extractions: [usage("u1")] }] });
		const s = createStagedGraphStore(base.store);
		s.upsertSource({ id: "src_x", filePath: "/x.txt", importedAt: "t1" });
		s.appendSourceUsage("src_x", usage("u2"));
		s.appendSourceUsage("src_x", usage("u2")); // idempotent per startedAt
		const view = s.readSources().find((x) => x.id === "src_x")!;
		assert.deepEqual(view.extractions?.map((e) => e.startedAt), ["u1", "u2"]);
	});
	it("a usage line for a source that exists nowhere is dropped, as the base does", () => {
		const base = memBase();
		const s = createStagedGraphStore(base.store);
		s.appendSourceUsage("src_ghost", usage("u1"));
		s.commit();
		assert.deepEqual(base.sourcesNow(), []);
	});
	it("positions: a staged write is what the staged view reads, and the base keeps its own until settled", () => {
		const base = memBase();
		base.store.writePositions({ n_a: { x: 1, y: 1 } });
		const s = createStagedGraphStore(base.store);
		assert.deepEqual(s.readPositions(), { n_a: { x: 1, y: 1 } });
		s.writePositions({ n_b: { x: 2, y: 2 } });
		assert.deepEqual(s.readPositions(), { n_b: { x: 2, y: 2 } });
		assert.deepEqual(base.store.readPositions(), { n_a: { x: 1, y: 1 } });
	});
});

describe("staged graph store: writes stay staged until commit", () => {
	it("writes never reach the base before commit", () => {
		const base = memBase({ nodes: [node("n_base")] });
		const before = base.snapshot();
		const s = createStagedGraphStore(base.store);
		s.appendNode(node("n_new"));
		s.appendChain(chain("arg_new", ["n_base"], "n_new"));
		s.appendCoverage({ chatId: "src_chapter", messageId: "m", fingerprint: "f" } as CoverageEntry);
		s.appendCheckpoint({ chatId: "src_chapter", foldedAt: "t" } as SessionCheckpoint);
		s.upsertSource({ id: "src_chapter", filePath: "/c.txt", importedAt: "t" });
		s.writePositions({ n_new: { x: 0, y: 0 } });
		assert.equal(base.snapshot(), before);
		assert.deepEqual(base.log, []);
	});
	it("commit replays sources, usage, nodes, chains, coverage and checkpoints into the base, in that order, once", () => {
		const base = memBase();
		const s = createStagedGraphStore(base.store);
		// Staged in a different order on purpose: the replay order is the contract, not the write order.
		s.appendCheckpoint({ chatId: "src_chapter", foldedAt: "t" } as SessionCheckpoint);
		s.appendChain(chain("arg_1", ["n_1"], "n_2"));
		s.appendNode(node("n_1"));
		s.appendCoverage({ chatId: "src_chapter", messageId: "m", fingerprint: "f" } as CoverageEntry);
		s.upsertSource({ id: "src_chapter", filePath: "/c.txt", importedAt: "t" });
		s.appendSourceUsage("src_chapter", usage("u1"));
		s.appendNode(node("n_2"));
		const stats = s.commit();
		assert.deepEqual(stats, { sources: 1, usage: 1, nodes: 2, chains: 1, coverage: 1, checkpoints: 1 });
		assert.deepEqual(base.log, ["source:src_chapter", "usage:src_chapter", "node:n_1", "node:n_2", "chain:arg_1", "coverage", "checkpoint"]);
		const afterFirst = base.snapshot();
		assert.deepEqual(s.commit(), { sources: 0, usage: 0, nodes: 0, chains: 0, coverage: 0, checkpoints: 0 }, "a second commit is a no-op");
		assert.equal(base.snapshot(), afterFirst);
		assert.equal(s.state, "committed");
	});
	it("writes after commit throw, so nothing is silently lost", () => {
		const s = createStagedGraphStore(memBase().store);
		s.commit();
		assert.throws(() => s.appendNode(node("n_late")), /after commit/);
	});
	it("discard drops every staged write and nothing reaches the base", () => {
		const base = memBase({ nodes: [node("n_base")] });
		const before = base.snapshot();
		const s = createStagedGraphStore(base.store);
		s.appendNode(node("n_new"));
		s.upsertSource({ id: "src_chapter", filePath: "/c.txt", importedAt: "t" });
		s.discard();
		assert.equal(s.state, "discarded");
		assert.deepEqual(s.readNodes().map((n) => n.id), ["n_base"]);
		assert.deepEqual(s.readSources(), []);
		assert.equal(base.snapshot(), before);
		assert.throws(() => s.appendNode(node("n_again")), /after discard/);
		assert.throws(() => s.commit(), /after discard/);
	});
	it("a commit that throws half-way is not replayed: the second call does nothing", () => {
		const base = memBase();
		let fail = true;
		const flaky: GraphStore = { ...base.store, appendNode: (n) => { if (fail && n.id === "n_2") throw new Error("disk full"); base.store.appendNode(n); } };
		const s = createStagedGraphStore(flaky);
		s.appendNode(node("n_1"));
		s.appendNode(node("n_2"));
		assert.throws(() => s.commit(), /disk full/);
		fail = false;
		assert.equal(s.commit().nodes, 0, "the second call is a no-op: the first node is not written twice");
		assert.deepEqual(base.nodesNow().map((n) => n.id), ["n_1"]);
	});
});

describe("staged graph store: links, merges and rewrites", () => {
	it("a link-append to an existing node stays staged: the base line is unchanged and the node stays visible", () => {
		const base = memBase({ nodes: [node("n_base", { name: "Sigma algebra", statement: "a family closed under complement" })] });
		const before = base.snapshot();
		const s = createStagedGraphStore(base.store);
		s.appendNode(node("n_base", { name: "Sigma algebra", statement: "a collection closed under complements", provenance: [{ chatId: "src_chapter", messageId: "" }] }));
		assert.equal(base.snapshot(), before, "the base is untouched while staged");
		const view = getGraph(s).nodes.find((n) => n.id === "n_base")!;
		assert.equal(view.name, "Sigma algebra", "the first line's name stands");
		assert.ok(view.aliases.includes("a collection closed under complements"), "the staged phrasing shows in the merged view");
		assert.equal(getGraph(base.store).nodes.find((n) => n.id === "n_base")!.aliases.length, 0, "the real graph view is unchanged");
		s.commit();
		assert.equal(base.nodesNow().filter((n) => n.id === "n_base").length, 2, "commit appends the link line");
	});
	it("a staged chain rewrite drops staged lines only, never a base line", () => {
		const base = memBase({ chains: [chain("arg_base", ["n_a", "n_b"], "n_c", "chat_base")] });
		const s = createStagedGraphStore(base.store);
		s.appendChain(chain("arg_s1", ["n_a"], "n_c"));
		s.appendChain(chain("arg_s2", ["n_x"], "n_y"));
		// The simplification keeps the base chain (even if it would call it redundant) and the first staged chain only.
		s.rewriteLedgers({ chains: [chain("arg_base", ["n_a", "n_b"], "n_c", "chat_base"), chain("arg_s1", ["n_a"], "n_c")] });
		assert.deepEqual(s.readChains().map((c) => c.id), ["arg_base", "arg_s1"]);
		s.commit();
		assert.deepEqual(base.chainsNow().map((c) => c.id), ["arg_base", "arg_s1"]);
	});
	it("deleteSources and node, coverage or checkpoint rewrites throw explicitly", () => {
		const s = createStagedGraphStore(memBase().store);
		assert.throws(() => s.deleteSources(new Set(["src_x"])), /not staged/);
		assert.throws(() => s.rewriteLedgers({ nodes: [] }), /chains only/);
		assert.throws(() => s.rewriteLedgers({ coverage: [] }), /chains only/);
		assert.throws(() => s.rewriteLedgers({ checkpoints: [] }), /chains only/);
	});
});
