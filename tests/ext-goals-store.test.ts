// tests/ext-goals-store.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import { createGoalsStore } from "../src/store/ext/goals-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const created: GoalEvent = {
	type: "created",
	goalId: "goal_a",
	title: "Understand X",
	origin: "chat",
	originRef: "chat_1",
	targetNodeIds: ["n_1"],
	priority: 3,
	at: "2026-11-04T10:00:00.000Z",
};

describe("goals store", () => {
	it("persists events to goals.jsonl and derives the goal back", () => {
		const dir = tmp();
		const store = createGoalsStore(dir);
		store.appendEvent(created);
		store.appendEvent({ type: "status", goalId: "goal_a", status: "paused", at: "2026-11-04T11:00:00.000Z" });
		assert.equal(fs.existsSync(path.join(dir, "goals.jsonl")), true);
		const goals = deriveGoals(createGoalsStore(dir).readEvents());
		assert.equal(goals[0]?.status, "paused");
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createGoalsStore(dir);
		assert.throws(() => store.appendEvent({ ...created, priority: 9 }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "goals.jsonl")), false);
	});
});
