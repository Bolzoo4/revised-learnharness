// tests/ext-review-state.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recallProbability } from "../src/core/ext/fsrs.ts";
import { deriveMarks, deriveNodeStates } from "../src/core/ext/review-state.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const DAY = 86_400_000;
const T0 = "2026-11-04T10:00:00.000Z";
const at = (days: number) => new Date(Date.parse(T0) + days * DAY).toISOString();
const opts = { retentionOf: () => 0.9, exists: () => true, implicitWeight: 0.5 };

const review = (nodeId: string, rating: 1 | 2 | 3 | 4, day: number, channel: "fixed" | "dialogic" | "exercise" = "fixed"): ReviewEvent => ({
	type: "review", nodeId, channel, rating, durationSec: 10, at: at(day),
});

describe("deriveNodeStates", () => {
	it("all channels update the node's single state (REQ-pl-04)", () => {
		const states = deriveNodeStates([review("n_1", 3, 0, "fixed"), review("n_1", 3, 3, "dialogic"), review("n_1", 3, 9, "exercise")], opts);
		assert.equal(states.size, 1);
		assert.equal(states.get("n_1")?.card.reps, 3);
		assert.equal(states.get("n_1")?.fixedReviews, 1);
	});

	it("ignores events for deleted nodes (umbrella REQ-review-01)", () => {
		const states = deriveNodeStates([review("n_gone", 3, 0), review("n_1", 3, 0)], { ...opts, exists: (id) => id === "n_1" });
		assert.deepEqual([...states.keys()], ["n_1"]);
	});

	it("is a pure replay: same events, same result (REQ-pl-16)", () => {
		const events = [review("n_1", 3, 0), review("n_1", 1, 4), review("n_2", 4, 1)];
		assert.deepEqual(deriveNodeStates(events, opts), deriveNodeStates(events, opts));
	});

	it("an implicit credit raises stability and an implicit event never creates a state", () => {
		const events: ReviewEvent[] = [
			review("n_1", 3, 0),
			{ type: "implicit", nodeId: "n_1", viaNodeId: "n_9", outcome: "credit", at: at(3) },
			{ type: "implicit", nodeId: "n_ghost", viaNodeId: "n_9", outcome: "credit", at: at(3) },
		];
		const without = deriveNodeStates(events.slice(0, 1), opts).get("n_1")!;
		const states = deriveNodeStates(events, opts);
		assert.ok(states.get("n_1")!.card.stability > without.card.stability);
		assert.equal(states.has("n_ghost"), false);
	});

	it("an implicit penalty acts as an Again", () => {
		const events: ReviewEvent[] = [
			review("n_1", 3, 0),
			{ type: "implicit", nodeId: "n_1", viaNodeId: "n_9", outcome: "penalty", at: at(3) },
		];
		const states = deriveNodeStates(events, opts);
		assert.equal(states.get("n_1")!.card.lapses, 1);
	});

	it("a failed review lowers later recall relative to a successful one", () => {
		const good = deriveNodeStates([review("n_1", 3, 0), review("n_1", 3, 3)], opts).get("n_1")!;
		const bad = deriveNodeStates([review("n_1", 3, 0), review("n_1", 1, 3)], opts).get("n_1")!;
		assert.ok(recallProbability(bad.card, at(10)) < recallProbability(good.card, at(10)));
	});
});

describe("deriveMarks", () => {
	it("the latest event wins for pin, retire, channel and goal retention", () => {
		const marks = deriveMarks([
			{ type: "pin", nodeId: "n_1", pinned: true, at: T0 },
			{ type: "pin", nodeId: "n_2", pinned: true, at: T0 },
			{ type: "pin", nodeId: "n_2", pinned: false, at: T0 },
			{ type: "retire", nodeId: "n_3", retired: true, at: T0 },
			{ type: "channel", nodeId: "n_1", channel: "dialogic", at: T0 },
			{ type: "channel", nodeId: "n_4", channel: "fixed", at: T0 },
			{ type: "channel", nodeId: "n_4", channel: null, at: T0 },
			{ type: "retention", goalId: "goal_a", retention: 0.8, at: T0 },
			{ type: "retention", goalId: "goal_a", retention: 0.85, at: T0 },
		]);
		assert.deepEqual([...marks.pinned], ["n_1"]);
		assert.deepEqual([...marks.retired], ["n_3"]);
		assert.deepEqual([...marks.channelPin], [["n_1", "dialogic"]]);
		assert.equal(marks.retention.get("goal_a"), 0.85);
	});
});
