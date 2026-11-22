// tests/ext-stage.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DERIVABLE_RECALL } from "../src/core/ext/deck.ts";
import { isTaught, nodeStage, stageCounts, stagesFor } from "../src/core/ext/stage.ts";
import { stagesOf } from "../src/server/ext/stage-live.ts";
import type { ReviewDeps } from "../src/core/ext/review-service.ts";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";

const base = { inActiveGoalScope: true, taught: true, recall: null as number | null, hasReviewHistory: false };

describe("nodeStage (REQ-graph-agent-13/14)", () => {
	it("uses the existing DERIVABLE_RECALL threshold", () => {
		assert.equal(DERIVABLE_RECALL, 0.85);
	});
	it("recall exactly at the threshold is confirmed", () => {
		assert.equal(nodeStage({ ...base, recall: 0.85, hasReviewHistory: true }), "confirmed");
	});
	it("recall just under the threshold is unrevised when taught", () => {
		assert.equal(nodeStage({ ...base, recall: 0.8499, hasReviewHistory: true }), "unrevised");
	});
	it("confirmed wins over every other rule", () => {
		assert.equal(nodeStage({ inActiveGoalScope: true, taught: false, recall: 0.99, hasReviewHistory: false }), "confirmed");
	});
	it("in an active goal scope, not taught, no recall -> staged", () => {
		assert.equal(nodeStage({ ...base, taught: false }), "staged");
	});
	it("in an active goal scope, taught, no recall yet -> unrevised", () => {
		assert.equal(nodeStage({ ...base, taught: true, recall: null }), "unrevised");
	});
	it("in scope with a low recall and no history yet is staged when not taught", () => {
		assert.equal(nodeStage({ inActiveGoalScope: true, taught: false, recall: 0.3, hasReviewHistory: false }), "staged");
	});
	it("outside every goal scope with no review history -> confirmed (came from the learner's own work)", () => {
		assert.equal(nodeStage({ inActiveGoalScope: false, taught: true, recall: null, hasReviewHistory: false }), "confirmed");
	});
	it("outside every goal scope with chat provenance but no reviews is still confirmed", () => {
		assert.equal(nodeStage({ inActiveGoalScope: false, taught: true, recall: null, hasReviewHistory: false }), "confirmed");
	});
	it("outside every goal scope with review history and low recall is unrevised, never staged", () => {
		assert.equal(nodeStage({ inActiveGoalScope: false, taught: true, recall: 0.4, hasReviewHistory: true }), "unrevised");
		assert.equal(nodeStage({ inActiveGoalScope: false, taught: false, recall: 0.4, hasReviewHistory: true }), "unrevised");
	});
	it("staged is only returned for in-scope nodes", () => {
		for (const taught of [true, false]) {
			for (const recall of [null, 0, 0.5]) {
				for (const hasReviewHistory of [true, false]) {
					const stage = nodeStage({ inActiveGoalScope: false, taught, recall, hasReviewHistory });
					assert.notEqual(stage, "staged");
				}
			}
		}
	});
});

describe("isTaught", () => {
	it("a node whose provenance is only src_ entries and has no review is not taught", () => {
		assert.equal(isTaught(["src_abc", "src_def"], false), false);
	});
	it("a node with no provenance and no review is not taught", () => {
		assert.equal(isTaught([], false), false);
	});
	it("a chat_ provenance entry means taught", () => {
		assert.equal(isTaught(["chat_1"], false), true);
	});
	it("a mix of src_ and chat_ entries means taught", () => {
		assert.equal(isTaught(["src_abc", "chat_1"], false), true);
	});
	it("any review history means taught, even with only src_ provenance", () => {
		assert.equal(isTaught(["src_abc"], true), true);
	});
});

describe("stagesFor", () => {
	const nodes = [
		{ id: "a", provenance: [{ chatId: "chat_1" }] }, // in scope, taught, no recall -> unrevised
		{ id: "b", provenance: [{ chatId: "src_doc" }] }, // in scope, not taught -> staged
		{ id: "c", provenance: [{ chatId: "src_doc" }] }, // in scope, reviewed, recall 0.9 -> confirmed
		{ id: "d", provenance: [{ chatId: "chat_2" }] }, // out of scope, reviewed, recall 0.2 -> unrevised
		{ id: "e", provenance: [{ chatId: "src_doc" }] }, // out of scope, no history -> confirmed
		{ id: "f", provenance: [{ chatId: "src_doc" }] }, // in scope, reviewed, recall 0.5 -> unrevised
	];
	const stages = stagesFor(nodes, {
		activeScope: new Set(["a", "b", "c", "f"]),
		recall: new Map([
			["c", 0.9],
			["d", 0.2],
			["f", 0.5],
		]),
		reviewed: new Set(["c", "d", "f"]),
	});

	it("maps every node to its derived stage", () => {
		assert.equal(stages.size, nodes.length);
		assert.equal(stages.get("a"), "unrevised");
		assert.equal(stages.get("b"), "staged");
		assert.equal(stages.get("c"), "confirmed");
		assert.equal(stages.get("d"), "unrevised");
		assert.equal(stages.get("e"), "confirmed");
		assert.equal(stages.get("f"), "unrevised");
	});
});

describe("stageCounts", () => {
	it("counts each stage and zero-fills the missing ones", () => {
		assert.deepEqual(stageCounts(["staged", "confirmed", "staged"]), { staged: 2, unrevised: 0, confirmed: 1 });
	});
	it("an empty input gives all zeros", () => {
		assert.deepEqual(stageCounts([]), { staged: 0, unrevised: 0, confirmed: 0 });
	});
});

describe("stagesOf (live assembly, fake stores)", () => {
	const NOW = "2026-11-22T10:00:00.000Z";
	const node = (id: string, chatId: string) => ({ id, name: id, statement: id, provenance: [{ chatId, messageId: "" }] });
	const nodes = [
		node("g", "chat_1"), // goal target, taught in chat, never reviewed -> unrevised
		node("p", "src_doc"), // premise of g, reviewed just now -> confirmed
		node("q", "src_doc"), // premise of g, document only, not reviewed -> staged
		node("x", "src_doc"), // outside every goal, never reviewed -> confirmed
		node("y", "src_doc"), // outside every goal, reviewed long ago -> unrevised
	];
	const chains = [{ premises: ["p", "q"], conclusion: "g" }];
	const goalEvents = (status: "active" | "paused"): GoalEvent[] => [
		{ type: "created", goalId: "goal_1", title: "G", origin: "user", originRef: "", targetNodeIds: ["g"], priority: 3, at: NOW },
		...(status === "paused" ? [{ type: "status" as const, goalId: "goal_1", status: "paused" as const, at: NOW }] : []),
	];
	const reviews: ReviewEvent[] = [
		{ type: "review", nodeId: "p", channel: "dialogic", rating: 3, durationSec: 10, at: NOW },
		{ type: "review", nodeId: "y", channel: "dialogic", rating: 3, durationSec: 10, at: "2026-11-01T10:00:00.000Z" },
	];
	const deps = (status: "active" | "paused"): ReviewDeps =>
		({
			graphStore: { readNodes: () => nodes, readChains: () => chains },
			goalsStore: { readEvents: () => goalEvents(status) },
			reviewStore: { readEvents: () => reviews },
			cardsStore: { readEvents: () => [] },
		}) as unknown as ReviewDeps;

	it("assembles the stage of each node from the goal scope and the review ledger", () => {
		const stages = stagesOf(deps("active"), NOW);
		assert.equal(stages.get("g"), "unrevised");
		assert.equal(stages.get("p"), "confirmed");
		assert.equal(stages.get("q"), "staged");
		assert.equal(stages.get("x"), "confirmed");
		assert.equal(stages.get("y"), "unrevised");
	});
	it("a paused goal contributes no scope, so its untaught nodes are no longer staged", () => {
		const stages = stagesOf(deps("paused"), NOW);
		assert.equal(stages.get("q"), "confirmed");
		assert.equal(stages.get("g"), "confirmed");
	});
});
