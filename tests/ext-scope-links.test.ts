// tests/ext-scope-links.test.ts
/**
 * One weighted scope everywhere (a node reached only by a typed link is in the
 * goal's scope for stage, frontier, gaps and the node panel), links never dangle
 * (the snapshot drops a link with a dead endpoint; deleting sources removes the
 * links of the nodes they kill).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { deleteChatTraces, deleteSourcesTraces } from "../src/core/graph-deletion.ts";
import { regionOf } from "../src/core/ext/frontier.ts";
import { reachFromGoals } from "../src/core/ext/gaps.ts";
import { activeScope, DEFAULT_WEIGHTS, deriveGoals, type Goal, type GoalWeights } from "../src/core/ext/goals.ts";
import type { Link } from "../src/core/ext/links.ts";
import { buildNodePanel } from "../src/core/ext/node-panel.ts";
import { snapshot, type ReviewDeps } from "../src/core/ext/review-service.ts";
import { stagesOf } from "../src/core/ext/stage.ts";
import type { GraphStore } from "../src/core/ports.ts";

const AT = "2026-11-01T00:00:00.000Z";
const NOW = "2026-11-06T10:00:00.000Z";
const node = (id: string): GraphNode => ({ id, name: id, statement: `${id} holds.`, aliases: [], createdAt: AT, provenance: [] });
const link = (from: string, to: string, linkType: Link["linkType"] = "analogy"): Link => ({
	id: `lk_${from}_${to}`,
	from,
	to,
	linkType,
	directed: false,
	origin: "user",
	createdAt: AT,
});

/** A goal whose only target is n_a, with the given weights (defaults: every weight 1). */
function goalWith(weights: Partial<GoalWeights> = {}): Goal {
	const full: GoalWeights = { ...DEFAULT_WEIGHTS, ...weights };
	const [goal] = deriveGoals([
		{ type: "created", goalId: "g_one", title: "One", origin: "user", originRef: "", targetNodeIds: ["n_a"], priority: 3, weights: full, at: AT },
	]);
	return goal!;
}

/** Review deps over in-memory ledgers; any write throws. */
function depsOver(nodes: GraphNode[], goals: Goal[], links: Link[]): ReviewDeps {
	const goalEvents = goals.map((g) => ({ type: "created" as const, goalId: g.id, title: g.title, origin: "user" as const, originRef: "", targetNodeIds: g.targetNodeIds, priority: 3, weights: g.weights, at: AT }));
	return {
		graphStore: { readNodes: () => nodes, readChains: (): GraphChain[] => [] },
		goalsStore: {
			readEvents: () => goalEvents,
			appendEvent: () => {
				throw new Error("write");
			},
		} as ReviewDeps["goalsStore"],
		reviewStore: {
			readEvents: () => [],
			appendEvent: () => {
				throw new Error("write");
			},
		} as ReviewDeps["reviewStore"],
		cardsStore: {
			readEvents: () => [],
			appendEvent: () => {
				throw new Error("write");
			},
		} as ReviewDeps["cardsStore"],
		linksStore: { readLinks: () => links },
		now: () => NOW,
	};
}

describe("one weighted scope: a node reached only by a link", () => {
	it("is in the active scope at link weight 1 and out of it at weight 0", () => {
		const links = [link("n_a", "n_x")];
		assert.ok(activeScope([goalWith()], [], links).includes("n_x"));
		assert.ok(!activeScope([goalWith({ analogy: 0 })], [], links).includes("n_x"));
	});

	it("stage: staged when untaught at weight 1, confirmed at weight 0", () => {
		const nodes = [node("n_a"), node("n_x")];
		const at1 = stagesOf(depsOver(nodes, [goalWith()], [link("n_a", "n_x")]), NOW);
		assert.equal(at1.get("n_x"), "staged");
		const at0 = stagesOf(depsOver(nodes, [goalWith({ analogy: 0 })], [link("n_a", "n_x")]), NOW);
		assert.equal(at0.get("n_x"), "confirmed");
	});

	it("frontier: the goal's region holds the linked node at weight 1 and not at weight 0", () => {
		const scope = { kind: "goal" as const, id: "g_one" };
		assert.ok(regionOf(scope, [goalWith()], [], [link("n_a", "n_x")]).has("n_x"));
		assert.ok(!regionOf(scope, [goalWith({ analogy: 0 })], [], [link("n_a", "n_x")]).has("n_x"));
	});

	it("gaps: the linked node is among the nodes reached from the goal at weight 1, not at weight 0", () => {
		assert.ok(reachFromGoals([goalWith()], [], 0.5, [link("n_a", "n_x")]).has("n_x"));
		assert.ok(!reachFromGoals([goalWith({ analogy: 0 })], [], 0.5, [link("n_a", "n_x")]).has("n_x"));
	});

	it("node panel: the goal is listed for the linked node at weight 1, not at weight 0", () => {
		const panel = (goal: Goal, links: Link[]) =>
			buildNodePanel("n_x", {
				graph: { readNodes: () => [node("n_a"), node("n_x")], readChains: () => [] },
				explanationEvents: [],
				goalEvents: [{ type: "created", goalId: goal.id, title: goal.title, origin: "user", originRef: "", targetNodeIds: ["n_a"], priority: 3, weights: goal.weights, at: AT }],
				sources: {},
				costAllowed: true,
				availableActions: [],
				links,
			} as Parameters<typeof buildNodePanel>[1]);
		assert.deepEqual(panel(goalWith(), [link("n_a", "n_x")])!.goals.map((g) => g.id), ["g_one"]);
		assert.deepEqual(panel(goalWith({ analogy: 0 }), [link("n_a", "n_x")])!.goals, []);
	});
});

describe("links never dangle", () => {
	it("the snapshot keeps only links whose both endpoints are live nodes", () => {
		const deps = depsOver([node("n_a"), node("n_b")], [], [link("n_a", "n_b"), link("n_a", "n_gone"), link("n_gone2", "n_b")]);
		const snap = snapshot(deps, NOW);
		assert.deepEqual(snap.links.map((l) => [l.from, l.to]), [["n_a", "n_b"]]);
	});
});

/** An in-memory GraphStore with just the ledgers the deletion touches. */
function memoryGraph(nodes: Array<GraphNode & { provenance: Array<{ chatId: string; messageId: string }> }>): GraphStore {
	let state = { nodes: [...nodes] as GraphNode[], chains: [] as GraphChain[], coverage: [] as unknown[], checkpoints: [] as unknown[] };
	const store = {
		readNodes: () => state.nodes,
		readChains: () => state.chains,
		readCoverage: () => state.coverage,
		readCheckpoints: () => state.checkpoints,
		readPositions: () => ({}),
		writePositions: () => undefined,
		rewriteLedgers(next: Partial<typeof state>) {
			state = { ...state, ...next };
		},
	};
	return store as unknown as GraphStore;
}

/** A link sink over a list: removeNode drops every link touching the node, as the app's store does. */
function sinkOver(initial: Link[]) {
	let links = [...initial];
	const removed: string[] = [];
	return {
		links: () => links,
		removed,
		sink: {
			readLinks: () => links,
			appendLink: () => undefined,
			remapNodes: () => undefined,
			removeNode(nodeId: string) {
				removed.push(nodeId);
				links = links.filter((l) => l.from !== nodeId && l.to !== nodeId);
			},
		},
	};
}

describe("deleting sources removes the links of the nodes they kill", () => {
	const dead = { ...node("n_dead"), provenance: [{ chatId: "chat_gone", messageId: "m1" }] };
	const live = { ...node("n_live"), provenance: [{ chatId: "chat_keep", messageId: "m2" }] };

	it("deleteSourcesTraces (delete-nodes) removes every link of a node that dies", () => {
		const graph = memoryGraph([dead, live]);
		const s = sinkOver([link("n_dead", "n_live"), link("n_live", "n_dead", "sequence")]);
		deleteSourcesTraces(graph, new Set(["chat_gone"]), "delete-nodes", s.sink);
		assert.deepEqual(s.removed, ["n_dead"]);
		assert.deepEqual(s.links(), []);
	});

	it("a link between two surviving nodes stays", () => {
		const graph = memoryGraph([dead, live, node("n_other")]);
		const s = sinkOver([link("n_live", "n_other"), link("n_dead", "n_other")]);
		deleteSourcesTraces(graph, new Set(["chat_gone"]), "delete-nodes", s.sink);
		assert.deepEqual(s.links().map((l) => [l.from, l.to]), [["n_live", "n_other"]]);
	});

	it("deleteChatTraces passes the sink through", () => {
		const graph = memoryGraph([dead, live]);
		const s = sinkOver([link("n_dead", "n_live")]);
		deleteChatTraces(graph, "chat_gone", "delete-nodes", s.sink);
		assert.deepEqual(s.links(), []);
	});
});
