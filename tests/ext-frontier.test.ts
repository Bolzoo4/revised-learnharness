import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createMarkResolver,
	deriveMarks,
	frontierMode,
	modeAllows,
	parseFrontierEvent,
	type FrontierEvent,
	type Mark,
} from "../src/core/ext/frontier.ts";
import type { Goal } from "../src/core/ext/goals.ts";

const chains = [
	{ premises: ["a", "b"], conclusion: "c" },
	{ premises: ["c"], conclusion: "d" },
];
const goal: Goal = {
	id: "goal_1",
	title: "g",
	origin: "user",
	originRef: "",
	targetNodeIds: ["d"],
	priority: 3,
	status: "active",
	createdAt: "t",
	updatedAt: "t",
};

function set(id: string, over: Partial<Extract<FrontierEvent, { type: "set" }>> = {}): FrontierEvent {
	return {
		type: "set",
		markId: id,
		scope: { kind: "node", id: "a" },
		mark: "hold",
		note: "",
		author: "user",
		at: "2026-11-04T10:00:00.000Z",
		...over,
	};
}

describe("frontier events", () => {
	it("parses a set event and rejects bad shapes", () => {
		assert.deepEqual(parseFrontierEvent(set("m1", { maxDepth: 1, budgetUsd: 2 })), set("m1", { maxDepth: 1, budgetUsd: 2 }));
		assert.equal(parseFrontierEvent({ ...set("m1"), mark: "pause" }), null);
		assert.equal(parseFrontierEvent({ ...set("m1"), maxDepth: -1 }), null);
		assert.equal(parseFrontierEvent({ ...set("m1"), maxDepth: 1.5 }), null);
		assert.equal(parseFrontierEvent({ ...set("m1"), budgetUsd: 0 }), null);
		assert.equal(parseFrontierEvent({ ...set("m1"), scope: { kind: "region", id: "a" } }), null);
		assert.equal(parseFrontierEvent({ ...set("m1"), author: "bot" }), null);
		assert.equal(parseFrontierEvent({ type: "clear", markId: "", author: "user", at: "t" }), null);
	});

	it("a set with a known id replaces; a clear removes", () => {
		const marks = deriveMarks([set("m1"), set("m1", { mark: "stop" }), set("m2"), { type: "clear", markId: "m2", author: "user", at: "t" }]);
		assert.deepEqual(marks.map((m) => [m.id, m.mark]), [["m1", "stop"]]);
	});

	it("an agent event never touches a user-authored mark", () => {
		const marks = deriveMarks([
			set("m1", { author: "user", mark: "stop" }),
			set("m1", { author: "agent", mark: "expand" }),
			{ type: "clear", markId: "m1", author: "agent", at: "t" },
		]);
		assert.equal(marks.length, 1);
		assert.equal(marks[0]!.mark, "stop");
		assert.equal(marks[0]!.author, "user");
	});

	it("a user event can replace or clear an agent mark", () => {
		const replaced = deriveMarks([set("m1", { author: "agent" }), set("m1", { author: "user", mark: "stop" })]);
		assert.equal(replaced[0]!.author, "user");
		assert.deepEqual(deriveMarks([set("m1", { author: "agent" }), { type: "clear", markId: "m1", author: "user", at: "t" }]), []);
	});
});

describe("mark resolution", () => {
	const m = (id: string, over: Partial<Mark>): Mark => ({
		id,
		scope: { kind: "node", id: "a" },
		mark: "hold",
		note: "",
		author: "user",
		at: "2026-11-04T10:00:00.000Z",
		...over,
	});

	it("regions: node, subtree (premise closure) and goal", () => {
		const r = createMarkResolver(
			[m("n", { scope: { kind: "node", id: "b" } }), m("s", { scope: { kind: "subtree", id: "c" }, mark: "expand" }), m("g", { scope: { kind: "goal", id: "goal_1" }, mark: "stop" })],
			[goal],
			chains,
		);
		assert.equal(r.effective("b")!.id, "n"); // node beats subtree and goal
		assert.equal(r.effective("a")!.id, "s"); // subtree beats goal
		assert.equal(r.effective("d")!.id, "g"); // only the goal region holds d
		assert.equal(r.effective("zzz"), null);
	});

	it("a user mark beats a more specific agent mark", () => {
		const r = createMarkResolver(
			[m("agent-node", { author: "agent", scope: { kind: "node", id: "a" }, mark: "hold" }), m("user-goal", { scope: { kind: "goal", id: "goal_1" }, mark: "expand" })],
			[goal],
			chains,
		);
		assert.equal(r.effective("a")!.id, "user-goal");
	});

	it("same specificity: smaller region, then newer, then lower id", () => {
		const r = createMarkResolver(
			[
				m("big", { scope: { kind: "subtree", id: "d" } }),
				m("small", { scope: { kind: "subtree", id: "c" } }),
			],
			[goal],
			chains,
		);
		assert.equal(r.effective("a")!.id, "small");
		const t = createMarkResolver(
			[m("old", { at: "2026-11-04T09:00:00.000Z" }), m("new", { at: "2026-11-04T11:00:00.000Z" })],
			[],
			chains,
		);
		assert.equal(t.effective("a")!.id, "new");
		const same = createMarkResolver([m("b-id", {}), m("a-id", {})], [], chains);
		assert.equal(same.effective("a")!.id, "a-id");
	});
});

describe("mode", () => {
	const mark = (over: Partial<Mark>): Mark => ({ id: "m", scope: { kind: "node", id: "a" }, mark: "expand", note: "", author: "user", at: "t", ...over });

	it("maps marks to modes and applies the budget", () => {
		assert.equal(frontierMode(null, 0), "none");
		assert.equal(frontierMode(mark({}), 0), "expand");
		assert.equal(frontierMode(mark({ budgetUsd: 1 }), 0.99), "expand");
		assert.equal(frontierMode(mark({ budgetUsd: 1 }), 1), "hold");
		assert.equal(frontierMode(mark({ mark: "stop", budgetUsd: 1 }), 5), "stop");
	});

	it("stop excludes all, hold keeps verification only", () => {
		assert.equal(modeAllows("stop", "verification"), false);
		assert.equal(modeAllows("hold", "expansion"), false);
		assert.equal(modeAllows("hold", "verification"), true);
		assert.equal(modeAllows("none", "expansion"), true);
		assert.equal(modeAllows("expand", "expansion"), true);
	});
});
