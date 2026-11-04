// tests/ext-goals.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_GOAL_PRIORITY,
	activeScope,
	deriveGoals,
	goalScope,
	parseGoalEvent,
	type GoalEvent,
} from "../src/core/ext/goals.ts";

const created = (goalId: string, targets: string[], at = "2026-11-04T10:00:00.000Z"): Extract<GoalEvent, { type: "created" }> => ({
	type: "created",
	goalId,
	title: `Goal ${goalId}`,
	origin: "user",
	originRef: "",
	targetNodeIds: targets,
	priority: DEFAULT_GOAL_PRIORITY,
	at,
});

describe("parseGoalEvent", () => {
	it("accepts a well-formed created event", () => {
		assert.deepEqual(parseGoalEvent(created("goal_a", ["n_1"])), created("goal_a", ["n_1"]));
	});
	it("accepts a status event", () => {
		const e = { type: "status", goalId: "goal_a", status: "paused", at: "t" };
		assert.deepEqual(parseGoalEvent(e), e);
	});
	it("rejects bad shapes", () => {
		const base = created("goal_a", ["n_1"]);
		for (const bad of [
			null,
			"x",
			{ ...base, goalId: "" },
			{ ...base, title: "" },
			{ ...base, origin: "web" },
			{ ...base, targetNodeIds: [] },
			{ ...base, targetNodeIds: [""] },
			{ ...base, priority: 0 },
			{ ...base, priority: 6 },
			{ ...base, priority: 2.5 },
			{ type: "status", goalId: "goal_a", status: "done", at: "t" },
			{ type: "other", goalId: "goal_a", at: "t" },
		]) {
			assert.equal(parseGoalEvent(bad), null, JSON.stringify(bad));
		}
	});
});

describe("deriveGoals", () => {
	it("starts active and applies status events in order", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ type: "status", goalId: "goal_a", status: "paused", at: "2026-11-04T11:00:00.000Z" },
			{ type: "status", goalId: "goal_a", status: "reached", at: "2026-11-04T12:00:00.000Z" },
		]);
		assert.equal(goals.length, 1);
		assert.equal(goals[0]?.status, "reached");
		assert.equal(goals[0]?.createdAt, "2026-11-04T10:00:00.000Z");
		assert.equal(goals[0]?.updatedAt, "2026-11-04T12:00:00.000Z");
	});
	it("ignores a duplicate created and a status for an unknown goal", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_1"]),
			{ ...created("goal_a", ["n_2"]), title: "other" },
			{ type: "status", goalId: "goal_zzz", status: "paused", at: "t" },
		]);
		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0]?.targetNodeIds, ["n_1"]);
		assert.equal(goals[0]?.title, "Goal goal_a");
	});
	it("keeps creation order", () => {
		const ids = deriveGoals([created("goal_b", ["n_1"]), created("goal_a", ["n_2"])]).map((g) => g.id);
		assert.deepEqual(ids, ["goal_b", "goal_a"]);
	});
});

describe("goalScope", () => {
	const chains = [
		{ premises: ["n_a", "n_b"], conclusion: "n_c" },
		{ premises: ["n_c", "n_d"], conclusion: "n_t" },
		{ premises: ["n_x"], conclusion: "n_unrelated" },
	];
	it("is the target plus the transitive premise closure", () => {
		assert.deepEqual(new Set(goalScope(["n_t"], chains)), new Set(["n_t", "n_c", "n_d", "n_a", "n_b"]));
	});
	it("is just the targets when no chain concludes them", () => {
		assert.deepEqual(goalScope(["n_solo"], chains), ["n_solo"]);
	});
	it("lists each id once and starts with the targets", () => {
		const out = goalScope(["n_t", "n_c"], chains);
		assert.equal(new Set(out).size, out.length);
		assert.deepEqual(out.slice(0, 2), ["n_t", "n_c"]);
	});
	it("terminates on a cycle", () => {
		const cyc = [
			{ premises: ["n_b"], conclusion: "n_a" },
			{ premises: ["n_a"], conclusion: "n_b" },
		];
		assert.deepEqual(new Set(goalScope(["n_a"], cyc)), new Set(["n_a", "n_b"]));
	});
});

describe("activeScope", () => {
	it("unions the scopes of active goals only", () => {
		const goals = deriveGoals([
			created("goal_a", ["n_t"]),
			created("goal_b", ["n_other"]),
			{ type: "status", goalId: "goal_b", status: "paused", at: "t" },
		]);
		const chains = [{ premises: ["n_p"], conclusion: "n_t" }];
		assert.deepEqual(new Set(activeScope(goals, chains)), new Set(["n_t", "n_p"]));
	});
});
