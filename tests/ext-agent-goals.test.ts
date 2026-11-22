// tests/ext-agent-goals.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGraph, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import type { Link, LinkOrigin, LinkType } from "../src/core/ext/links.ts";
import {
	createAgentGoal,
	createAgentLink,
	setAgentGoalWeights,
	type AgentGoalsDeps,
	type AgentGoalInput,
} from "../src/server/ext/agent-goals.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { createCostGate, type CostEvent } from "../src/core/ext/cost-gate.ts";
import { ESTIMATED_IDENTITY_USD_PER_CALL, ESTIMATED_IMPORT_USD_PER_FILE } from "../src/server/ext/agent-goals.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 sample");
const NOW = "2026-11-22T10:00:00.000Z";

/** Stands in for the sandbox folder: the names it holds, and a refusal for any other name (the real checks are in ext-sandbox.test.ts). */
function fakeSandbox() {
	const files = new Map<string, Uint8Array>();
	return {
		put(name: string, bytes: Uint8Array = PDF_BYTES) {
			files.set(name, bytes);
		},
		root: () => "/sandbox-under-test",
		list: async () => ({ items: [], count: 0, truncated: false }),
		read: async (name: string) => (files.has(name) ? { ok: true as const, bytes: files.get(name)! } : { ok: false as const, reason: "is not a file in the sandbox folder" }),
	};
}

function memoryGoalsStore(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

function memoryLinks() {
	const links: Link[] = [];
	const appended: Array<{ from: string; to: string; linkType: LinkType; origin: LinkOrigin }> = [];
	let n = 0;
	return {
		links,
		appended,
		readLinks: () => [...links],
		appendLink(input: { from: string; to: string; linkType: LinkType; origin: LinkOrigin }, nodeIds: ReadonlySet<string>) {
			appended.push(input);
			if (!nodeIds.has(input.from) || !nodeIds.has(input.to)) throw new Error("invalid link: unknown node");
			const link: Link = { id: `link_${++n}`, ...input, directed: false, createdAt: NOW };
			links.push(link);
			return link;
		},
	};
}

function recordingGate(open = true) {
	const records: Array<{ usd: number; source: string }> = [];
	let held = 0;
	return {
		records,
		heldTotal: () => held,
		setOpen(value: boolean) {
			open = value;
		},
		allowed: () => open,
		reserve(usd: number, source: string) {
			if (!open) return null;
			held += usd;
			let live = true;
			const drop = () => {
				if (!live) return;
				live = false;
				held -= usd;
			};
			return {
				commit: () => {
					if (!live) return;
					records.push({ usd, source });
					drop();
				},
				release: drop,
			};
		},
	};
}

/** Stands in for the live PDF import: the document's nodes get a src_ provenance, as the notes pipeline gives them. */
function fakeDocuments(graphStore: ReturnType<typeof createMemoryGraphStore>) {
	const imported: Uint8Array[] = [];
	return {
		imported,
		async importPdf(bytes: Uint8Array) {
			imported.push(bytes);
			const sourceId = `src_doc${imported.length}`;
			const graphDeps = { graphStore, chatStore: undefined as never } as GraphDeps;
			mergeFindings(sourceId, { propositions: [{ id: "p1", name: "Document fact", statement: "The document states a fact.", aliases: [] }], chains: [] }, { links: [] }, graphDeps, { foldedAt: NOW });
			return { sourceId };
		},
	};
}

function setup(overrides: Partial<AgentGoalsDeps> = {}) {
	const graphStore = createMemoryGraphStore();
	const goalsStore = memoryGoalsStore();
	const linksStore = memoryLinks();
	const gate = recordingGate();
	const documents = fakeDocuments(graphStore);
	const sandbox = fakeSandbox();
	let g = 0;
	const deps: AgentGoalsDeps = {
		graphStore,
		goalsStore,
		linksStore,
		gate,
		documents,
		sandbox,
		now: () => NOW,
		newGoalId: () => `goal_agent${++g}`,
		...overrides,
	};
	return { deps, graphStore, goalsStore, linksStore, gate, documents, sandbox };
}

const validInput = (over: Partial<AgentGoalInput> = {}): AgentGoalInput => ({
	title: "Dominated convergence",
	targets: ["If |f_n| <= g and f_n -> f a.e., the integrals converge."],
	...over,
});

describe("createAgentGoal", () => {
	it("writes one created event with origin agent, creates the target nodes and reports them", async () => {
		const s = setup();
		const result = await createAgentGoal(validInput({ targets: ["A holds.", "B holds."] }), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.goalId, "goal_agent1");
		assert.equal(s.goalsStore.events.length, 1);
		const event = s.goalsStore.events[0]!;
		assert.equal(event.type, "created");
		assert.equal(event.type === "created" && event.origin, "agent");
		assert.equal(s.graphStore.readNodes().length, 2);
		assert.equal(result.nodeIds.length, 2);
		const goal = deriveGoals(s.goalsStore.readEvents()).find((x) => x.id === "goal_agent1");
		assert.equal(goal?.status, "active", "creation never marks anything learned");
		assert.deepEqual([...(goal?.targetNodeIds ?? [])].sort(), [...result.nodeIds].sort());
	});

	it("with the daily ceiling spent it returns 429 and writes nothing", async () => {
		const s = setup();
		s.gate.setOpen(false);
		s.sandbox.put("a.pdf");
		const result = await createAgentGoal(validInput({ files: [{ name: "a.pdf" }] }), s.deps);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.status, 429);
		assert.match(result.message, /ceiling/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
		assert.equal(s.documents.imported.length, 0);
		assert.equal(s.gate.records.length, 0);
	});

	it("invalid weights are a 400 and write nothing", async () => {
		const s = setup();
		const result = await createAgentGoal(validInput({ weights: { chain: 9 } }), s.deps);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.status, 400);
		assert.ok(result.problems && result.problems.length > 0);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
	});

	it("an out-of-range priority is a 400 naming priority", async () => {
		const s = setup();
		const result = await createAgentGoal(validInput({ priority: 9 }), s.deps);
		assert.equal(!result.ok && result.status, 400);
		assert.match(!result.ok ? result.message : "", /priority/);
		assert.equal(s.goalsStore.events.length, 0);
	});

	it("rejects a blank or over-long title, and missing targets, with the field named", async () => {
		const s = setup();
		const blank = await createAgentGoal(validInput({ title: "   " }), s.deps);
		assert.equal(!blank.ok && blank.status, 400);
		assert.match(!blank.ok ? blank.message : "", /title/);
		const long = await createAgentGoal(validInput({ title: "x".repeat(201) }), s.deps);
		assert.equal(!long.ok && long.status, 400);
		const none = await createAgentGoal(validInput({ targets: [] }), s.deps);
		assert.equal(!none.ok && none.status, 400);
		assert.match(!none.ok ? none.message : "", /targets/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
	});

	it("more than 20 targets, a target over 500 characters, or more than 5 files is a 400 with zero writes", async () => {
		const s = setup();
		const many = await createAgentGoal(validInput({ targets: Array.from({ length: 21 }, (_, i) => `t${i}`) }), s.deps);
		assert.equal(!many.ok && many.status, 400);
		const long = await createAgentGoal(validInput({ targets: ["y".repeat(501)] }), s.deps);
		assert.equal(!long.ok && long.status, 400);
		const files = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf` }));
		const tooMany = await createAgentGoal(validInput({ files }), s.deps);
		assert.equal(!tooMany.ok && tooMany.status, 400);
		assert.match(!tooMany.ok ? tooMany.message : "", /files/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
		assert.equal(s.documents.imported.length, 0);
	});

	it("a name the sandbox refuses is a 400 naming the file, with zero writes (file checks are in ext-sandbox.test.ts)", async () => {
		const s = setup();
		const refused = await createAgentGoal(validInput({ files: [{ name: "missing.pdf" }] }), s.deps);
		assert.equal(!refused.ok && refused.status, 400);
		assert.match(!refused.ok ? refused.message : "", /missing\.pdf/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.documents.imported.length, 0);
	});

	it("an attached file's nodes carry src_ document provenance, and the spend is recorded once on the agent kind after success", async () => {
		const s = setup();
		s.sandbox.put("notes.pdf");
		const result = await createAgentGoal(validInput({ files: [{ name: "notes.pdf" }] }), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(s.documents.imported.length, 1);
		const fileNodes = s.graphStore.readNodes().filter((n) => n.provenance.some((p) => p.chatId.startsWith("src_")));
		assert.equal(fileNodes.length, 1);
		assert.ok(result.nodeIds.includes(fileNodes[0]!.id));
		assert.equal(s.gate.records.length, 1);
		assert.equal(s.gate.records[0]?.source, "agent");
	});

	it("a failing document import writes no goal", async () => {
		const s = setup({
			documents: { importPdf: async () => Promise.reject(new Error("extraction failed")) },
		});
		s.sandbox.put("a.pdf");
		await assert.rejects(createAgentGoal(validInput({ files: [{ name: "a.pdf" }] }), s.deps), /extraction failed/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.gate.records.length, 0);
	});
});

describe("setAgentGoalWeights", () => {
	it("an unknown goal is a 404", () => {
		const s = setup();
		const result = setAgentGoalWeights("goal_ghost", { chain: 2 }, s.deps);
		assert.equal(!result.ok && result.status, 404);
		assert.equal(s.goalsStore.events.length, 0);
	});

	it("invalid weights are a 400 with the problems and no event", async () => {
		const s = setup();
		const created = await createAgentGoal(validInput(), s.deps);
		assert.equal(created.ok, true);
		const before = s.goalsStore.events.length;
		const result = setAgentGoalWeights("goal_agent1", { chain: -1, unknownKey: 2 }, s.deps);
		assert.equal(!result.ok && result.status, 400);
		assert.ok(!result.ok && (result.problems?.length ?? 0) >= 1);
		assert.equal(s.goalsStore.events.length, before);
	});

	it("valid weights append one weights event and return the goal", async () => {
		const s = setup();
		await createAgentGoal(validInput(), s.deps);
		const result = setAgentGoalWeights("goal_agent1", { chain: 0.5 }, s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.goal.weights.chain, 0.5);
		assert.equal(s.goalsStore.events.at(-1)?.type, "weights");
	});
});

describe("createAgentLink", () => {
	async function twoNodes() {
		const s = setup({ newGoalId: () => "goal_x" });
		await createAgentGoal(validInput({ targets: ["First holds.", "Second holds."] }), s.deps);
		const [a, b] = s.graphStore.readNodes().map((n) => n.id);
		return { s, a: a!, b: b! };
	}

	it("creates an agent-origin link between two known nodes", async () => {
		const { s, a, b } = await twoNodes();
		const result = createAgentLink({ from: a, to: b, linkType: "sequence" }, s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.link.origin, "agent");
		assert.equal(s.linksStore.links.length, 1);
	});

	it("an unknown node, an unknown type, a self-link or a duplicate is a 400 with the problems", async () => {
		const { s, a, b } = await twoNodes();
		const unknownNode = createAgentLink({ from: a, to: "node_ghost", linkType: "sequence" }, s.deps);
		assert.equal(!unknownNode.ok && unknownNode.status, 400);
		assert.match(!unknownNode.ok ? unknownNode.problems!.join(";") : "", /not a known node/);
		const badType = createAgentLink({ from: a, to: b, linkType: "nonsense" }, s.deps);
		assert.equal(!badType.ok && badType.status, 400);
		const self = createAgentLink({ from: a, to: a, linkType: "analogy" }, s.deps);
		assert.equal(!self.ok && self.status, 400);
		assert.equal(createAgentLink({ from: a, to: b, linkType: "analogy" }, s.deps).ok, true);
		const dup = createAgentLink({ from: b, to: a, linkType: "analogy" }, s.deps);
		assert.equal(!dup.ok && dup.status, 400);
		assert.equal(s.linksStore.links.length, 1);
	});
});

describe("createAgentGoal: the same request is reused, joined, and reserved before import (REQ-graph-agent-08, 18)", () => {
	it("the same request again returns the goal it made: reused, no import, no spend, and the key is stored on the event", async () => {
		const s = setup();
		s.sandbox.put("notes.pdf");
		const first = await createAgentGoal(validInput({ files: [{ name: "notes.pdf" }] }), s.deps);
		const second = await createAgentGoal(validInput({ files: [{ name: "notes.pdf" }] }), s.deps);
		assert.equal(first.ok && second.ok, true);
		if (!first.ok || !second.ok) return;
		assert.equal(first.reused, false);
		assert.equal(second.reused, true);
		assert.equal(second.goalId, first.goalId);
		for (const id of second.nodeIds) assert.ok(first.nodeIds.includes(id), "the reused answer names nodes of the goal");
		assert.equal(s.documents.imported.length, 1);
		assert.equal(s.gate.records.length, 1);
		assert.equal(s.goalsStore.events.length, 1);
		const created = s.goalsStore.events[0]!;
		assert.match(created.type === "created" && created.idemKey ? created.idemKey : "", /^[0-9a-f]{64}$/);
	});

	it("a request that differs in its targets is a different goal", async () => {
		const s = setup();
		const a = await createAgentGoal(validInput({ targets: ["A holds."] }), s.deps);
		const b = await createAgentGoal(validInput({ targets: ["B holds."] }), s.deps);
		assert.equal(a.ok && b.ok, true);
		if (!a.ok || !b.ok) return;
		assert.notEqual(a.goalId, b.goalId);
		assert.equal(b.reused, false);
	});

	it("an identical request while the first is still importing is joined: one goal, one import", async () => {
		const s = setup();
		s.sandbox.put("slow.pdf");
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const deps: AgentGoalsDeps = {
			...s.deps,
			documents: {
				importPdf: async (bytes: Uint8Array) => {
					await gate;
					return s.documents.importPdf(bytes);
				},
			},
		};
		const input = validInput({ files: [{ name: "slow.pdf" }] });
		const first = createAgentGoal(input, deps);
		const second = createAgentGoal(input, deps);
		open();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a.ok && b.ok, true);
		if (!a.ok || !b.ok) return;
		assert.equal(a.goalId, b.goalId);
		assert.equal([a.reused, b.reused].filter(Boolean).length, 1, "exactly one of the two is the joined answer");
		assert.equal(s.documents.imported.length, 1);
		assert.equal(s.goalsStore.events.length, 1);
	});

	it("an existing goal is answered (reused) even when the ceiling is now spent, and nothing is spent", async () => {
		const s = setup();
		await createAgentGoal(validInput(), s.deps);
		s.gate.setOpen(false);
		const again = await createAgentGoal(validInput(), s.deps);
		assert.equal(again.ok && again.reused, true);
		assert.equal(s.gate.records.length, 0);
	});

	it("two parallel requests that each need more than half of the remaining budget: only one passes", async () => {
		const store: { events: CostEvent[]; appendEvent(e: CostEvent): void; readEvents(): CostEvent[] } = {
			events: [],
			appendEvent(e) {
				this.events.push(e);
			},
			readEvents() {
				return [...this.events];
			},
		};
		const ceiling = createCostGate({ store, ceilingUsd: 0.15, now: () => NOW });
		const s = setup({
			gate: { allowed: () => ceiling.allowed(), reserve: (usd, source) => ceiling.reserve?.(usd, source) ?? null },
			documents: {
				importPdf: async (bytes: Uint8Array) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return s.documents.importPdf(bytes);
				},
			},
		});
		for (const name of ["a1.pdf", "a2.pdf", "b1.pdf", "b2.pdf"]) s.sandbox.put(name);
		const [one, two] = await Promise.all([
			createAgentGoal(validInput({ title: "One", files: [{ name: "a1.pdf" }, { name: "a2.pdf" }] }), s.deps),
			createAgentGoal(validInput({ title: "Two", files: [{ name: "b1.pdf" }, { name: "b2.pdf" }] }), s.deps),
		]);
		const results = [one, two];
		assert.equal(results.filter((r) => r.ok).length, 1, "exactly one request is admitted");
		const refused = results.find((r) => !r.ok);
		assert.equal(!refused?.ok && refused?.status, 429);
		assert.equal(store.events.length, 1, "the admitted request is the only spend, and it is recorded once");
		assert.equal(store.events[0]!.usd, 2 * ESTIMATED_IMPORT_USD_PER_FILE);
	});

	it("a failed import releases its reservation: the budget is free again and nothing is recorded", async () => {
		const s = setup();
		s.sandbox.put("x.pdf");
		const failing: AgentGoalsDeps = { ...s.deps, documents: { importPdf: async () => Promise.reject(new Error("extraction failed")) } };
		await assert.rejects(createAgentGoal(validInput({ files: [{ name: "x.pdf" }] }), failing), /extraction failed/);
		assert.equal(s.gate.heldTotal(), 0);
		assert.equal(s.gate.records.length, 0);
	});
});

describe("createAgentGoal: a target already in the graph attaches to the existing node (REQ-graph-agent-26, 27)", () => {
	/** A judge that records what it was asked and answers with `answer` (index into the statements it was given). */
	function fakeIdentity(answer: (statements: string[]) => Map<number, string | null> | Promise<Map<number, string | null>>) {
		const seen: string[][] = [];
		return {
			seen,
			port: {
				identify: async (statements: string[]) => {
					seen.push([...statements]);
					return answer(statements);
				},
			},
		};
	}
	const nodeCount = (s: ReturnType<typeof setup>) => getGraph(s.graphStore).nodes.length;

	it("a target that equals an existing node after normalisation attaches to it: no new node, the goal's provenance is added, the judge is not called", async () => {
		const judge = fakeIdentity(() => new Map());
		const s = setup({ identity: judge.port });
		const first = await createAgentGoal(validInput({ targets: ["Convergenza dominata."] }), s.deps);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const existing = first.nodeIds[0]!;
		judge.seen.length = 0;
		const second = await createAgentGoal(validInput({ title: "Second", targets: ["convergenza DOMINATA"] }), s.deps);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(nodeCount(s), 1, "no second node");
		assert.equal(second.matchedExisting, 1);
		assert.equal(second.identityChecked, true);
		assert.deepEqual(second.nodeIds, [existing]);
		assert.deepEqual(judge.seen, [], "the model judgement is spared");
		const node = getGraph(s.graphStore).nodes.find((n) => n.id === existing)!;
		assert.ok(node.provenance.some((p) => p.chatId === second.goalId), "the node gains the goal's provenance");
		const created = deriveGoals(s.goalsStore.readEvents()).find((g) => g.id === second.goalId);
		assert.deepEqual(created?.targetNodeIds, [existing]);
	});

	it("the judge sees only the statements the first pass did not match, and a verdict naming an existing node attaches the target to it", async () => {
		let existing = "";
		const judge = fakeIdentity((statements) => (statements.length === 1 ? new Map([[0, existing]]) : new Map()));
		const s = setup({ identity: judge.port });
		const first = await createAgentGoal(validInput({ targets: ["Dominated convergence holds."] }), s.deps);
		if (!first.ok) return assert.fail("first goal");
		existing = first.nodeIds[0]!;
		judge.seen.length = 0;
		s.gate.records.length = 0;
		const second = await createAgentGoal(validInput({ title: "Second", targets: ["dominated convergence holds", "Under domination the integrals converge."] }), s.deps);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.deepEqual(judge.seen, [["Under domination the integrals converge."]]);
		assert.equal(second.matchedExisting, 2, "one by the first pass, one by the judgement");
		assert.equal(nodeCount(s), 1);
		assert.equal(s.gate.records.length, 1, "the judgement's estimated spend is recorded once, as agent spend");
		assert.deepEqual(s.gate.records[0], { usd: ESTIMATED_IDENTITY_USD_PER_CALL, source: "agent" });
		assert.equal(s.gate.heldTotal(), 0);
	});

	it("a verdict naming a node that is not in the graph is ignored: the target becomes a new node", async () => {
		const s = setup({ identity: fakeIdentity(() => new Map([[0, "node_ghost"]])).port });
		const result = await createAgentGoal(validInput({ targets: ["A new claim."] }), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.matchedExisting, 0);
		assert.equal(result.identityChecked, true);
		assert.equal(nodeCount(s), 1);
	});

	it("an auditor failure never blocks the goal: the targets become new nodes, identityChecked is false, the reservation is released and nothing is spent", async () => {
		const s = setup({
			identity: fakeIdentity(() => {
				throw new Error("model unavailable");
			}).port,
		});
		const result = await createAgentGoal(validInput({ targets: ["A claim the judge cannot reach."] }), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.identityChecked, false);
		assert.equal(result.matchedExisting, 0);
		assert.equal(nodeCount(s), 1);
		assert.equal(s.gate.heldTotal(), 0);
		assert.equal(s.gate.records.length, 0);
	});

	it("without a judge (no model configured), unmatched targets become new nodes and identityChecked is false", async () => {
		const s = setup();
		const result = await createAgentGoal(validInput({ targets: ["Only a fresh claim."] }), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.identityChecked, false);
		assert.equal(nodeCount(s), 1);
	});

	it("a reused answer repeats the matchedExisting and identityChecked of the goal it made", async () => {
		const s = setup({ identity: fakeIdentity(() => new Map()).port });
		await createAgentGoal(validInput({ targets: ["Matched claim."] }), s.deps);
		const again = await createAgentGoal(validInput({ targets: ["Matched claim."] }), s.deps);
		assert.equal(again.ok && again.reused, true);
		assert.equal(again.ok && again.matchedExisting, 0);
		assert.equal(again.ok && again.identityChecked, true);
	});
});
