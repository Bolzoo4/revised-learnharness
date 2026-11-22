// tests/ext-agent-goals.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeFindings, type GraphDeps } from "../src/core/graph.ts";
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

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 sample");
const pdfBase64 = (bytes: Uint8Array = PDF_BYTES) => Buffer.from(bytes).toString("base64");
const NOW = "2026-11-22T10:00:00.000Z";

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
	return {
		records,
		setOpen(value: boolean) {
			open = value;
		},
		allowed: () => open,
		record: (usd: number, source: string) => void records.push({ usd, source }),
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
	let g = 0;
	const deps: AgentGoalsDeps = {
		graphStore,
		goalsStore,
		linksStore,
		gate,
		documents,
		now: () => NOW,
		newGoalId: () => `goal_agent${++g}`,
		...overrides,
	};
	return { deps, graphStore, goalsStore, linksStore, gate, documents };
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
		const result = await createAgentGoal(validInput({ files: [{ name: "a.pdf", dataBase64: pdfBase64() }] }), s.deps);
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
		const files = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, dataBase64: pdfBase64() }));
		const tooMany = await createAgentGoal(validInput({ files }), s.deps);
		assert.equal(!tooMany.ok && tooMany.status, 400);
		assert.match(!tooMany.ok ? tooMany.message : "", /files/);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
		assert.equal(s.documents.imported.length, 0);
	});

	it("a file over 20 MB decoded, or one that is not base64 or not a PDF, is a 400 with zero writes", async () => {
		const s = setup();
		const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x25).toString("base64");
		const tooBig = await createAgentGoal(validInput({ files: [{ name: "big.pdf", dataBase64: big }] }), s.deps);
		assert.equal(!tooBig.ok && tooBig.status, 400);
		assert.match(!tooBig.ok ? tooBig.message : "", /20 MB/);
		const notBase64 = await createAgentGoal(validInput({ files: [{ name: "x.pdf", dataBase64: "not base64!!" }] }), s.deps);
		assert.equal(!notBase64.ok && notBase64.status, 400);
		const notPdf = await createAgentGoal(validInput({ files: [{ name: "x.pdf", dataBase64: pdfBase64(new TextEncoder().encode("plain")) }] }), s.deps);
		assert.equal(!notPdf.ok && notPdf.status, 400);
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.documents.imported.length, 0);
	});

	it("an attached file's nodes carry src_ document provenance, and the spend is recorded once on the agent kind after success", async () => {
		const s = setup();
		const result = await createAgentGoal(validInput({ files: [{ name: "notes.pdf", dataBase64: pdfBase64() }] }), s.deps);
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
		await assert.rejects(createAgentGoal(validInput({ files: [{ name: "a.pdf", dataBase64: pdfBase64() }] }), s.deps), /extraction failed/);
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
