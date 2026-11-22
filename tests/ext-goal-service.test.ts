// tests/ext-goal-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGoal, setWeights } from "../src/core/ext/goal-service.ts";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";

function memoryGoalsStore(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

function deps() {
	const graphStore = createMemoryGraphStore();
	const goalsStore = memoryGoalsStore();
	let n = 0;
	return {
		graphStore,
		goalsStore,
		now: () => "2026-11-04T10:00:00.000Z",
		newGoalId: () => `goal_test${++n}`,
	};
}

describe("createGoal", () => {
	it("creates the target node through the merger with the goal id as provenance", () => {
		const d = deps();
		const goal = createGoal(
			{ title: "Dominated convergence", statement: "If |f_n| <= g integrable and f_n -> f a.e., then the integrals converge.", origin: "chat", originRef: "chat_1" },
			d,
		);
		const nodes = d.graphStore.readNodes();
		assert.equal(nodes.length, 1);
		assert.equal(nodes[0]?.name, "Dominated convergence");
		assert.deepEqual(nodes[0]?.provenance, [{ chatId: "goal_test1", messageId: "" }]);
		assert.deepEqual(goal.targetNodeIds, [nodes[0]?.id]);
		assert.equal(goal.id, "goal_test1");
		assert.equal(goal.status, "active");
		assert.equal(goal.priority, 3);
		assert.equal(goal.origin, "chat");
	});

	it("appends exactly one created event that derives back to the goal", () => {
		const d = deps();
		createGoal({ title: "T", statement: "S is true.", origin: "user", originRef: "" }, d);
		assert.equal(d.goalsStore.events.length, 1);
		assert.equal(deriveGoals(d.goalsStore.readEvents()).length, 1);
	});

	it("with existingNodeId creates no node and targets that node", () => {
		const d = deps();
		const first = createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "" }, d);
		const nodeId = first.targetNodeIds[0]!;
		const second = createGoal(
			{ title: "B", existingNodeId: nodeId, origin: "user", originRef: "", priority: 5 },
			d,
		);
		assert.equal(d.graphStore.readNodes().length, 1);
		assert.deepEqual(second.targetNodeIds, [nodeId]);
		assert.equal(second.priority, 5);
	});

	it("throws on an unknown existingNodeId without writing anything", () => {
		const d = deps();
		assert.throws(
			() => createGoal({ title: "B", existingNodeId: "n_missing", origin: "user", originRef: "" }, d),
			/unknown node/,
		);
		assert.equal(d.goalsStore.events.length, 0);
	});

	it("validates before writing: empty title, empty statement, bad priority", () => {
		const d = deps();
		assert.throws(() => createGoal({ title: "", statement: "S.", origin: "user", originRef: "" }, d), /title/);
		assert.throws(() => createGoal({ title: "T", statement: "  ", origin: "user", originRef: "" }, d), /statement/);
		assert.throws(() => createGoal({ title: "T", statement: "S.", origin: "user", originRef: "", priority: 0 }, d), /priority/);
		assert.equal(d.graphStore.readNodes().length, 0);
		assert.equal(d.goalsStore.events.length, 0);
	});

	it("two goals get separate nodes and ids", () => {
		const d = deps();
		const a = createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "" }, d);
		const b = createGoal({ title: "B", statement: "B holds.", origin: "pdf", originRef: "doc_1" }, d);
		assert.notEqual(a.id, b.id);
		assert.notEqual(a.targetNodeIds[0], b.targetNodeIds[0]);
		assert.equal(d.graphStore.readNodes().length, 2);
	});
});

describe("goal weights in the service (REQ-graph-agent-17)", () => {
	const existing = (d: ReturnType<typeof deps>) => createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "" }, d);

	it("createGoal stores valid weights on the created event", () => {
		const d = deps();
		const goal = createGoal({ title: "A", statement: "A holds.", origin: "agent", originRef: "", weights: { analogy: 0.3 } }, d);
		assert.equal(goal.origin, "agent");
		assert.equal(goal.weights.analogy, 0.3);
		assert.equal(goal.weights.chain, 1);
	});
	it("createGoal rejects invalid weights before any write", () => {
		const d = deps();
		assert.throws(() => createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "", weights: { cites: 1 } }, d), /weight/);
		assert.throws(() => createGoal({ title: "A", statement: "A holds.", origin: "user", originRef: "", weights: { chain: 2 } }, d), /weight/);
		assert.equal(d.graphStore.readNodes().length, 0);
		assert.equal(d.goalsStore.events.length, 0);
	});
	it("setWeights merges the given keys onto the current weights and appends one weights event", () => {
		const d = deps();
		const goal = existing(d);
		const after = setWeights(goal.id, { contrast: 0 }, d);
		assert.equal(after.weights.contrast, 0);
		assert.equal(after.weights.chain, 1);
		assert.equal(d.goalsStore.events.at(-1)?.type, "weights");
		const again = setWeights(goal.id, { contrast: 0.5 }, d);
		assert.equal(again.weights.contrast, 0.5);
	});
	it("setWeights rejects an unknown key, an out-of-range value and an unknown goal, writing nothing", () => {
		const d = deps();
		const goal = existing(d);
		const before = d.goalsStore.events.length;
		assert.throws(() => setWeights(goal.id, { cites: 0.5 }, d), /unknown/);
		assert.throws(() => setWeights(goal.id, { chain: 1.5 }, d), /weight/);
		assert.throws(() => setWeights("goal_nope", { chain: 0.5 }, d), /unknown goal/);
		assert.equal(d.goalsStore.events.length, before);
	});
});
