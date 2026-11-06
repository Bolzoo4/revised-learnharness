// tests/ext-review-node.test.ts
// "With the tutor": a tutor session focused on a node that has no card. Server
// session creation, the node focus in the tutor context, the nodes without a card
// in today's plan, and the node-focused instructions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersonalLayer } from "../src/server/ext/personal-layer.ts";
import { focusedNodeReviewInstructions, REVIEW_INSTRUCTIONS } from "../src/agent/ext/review-instructions.ts";
import { ReviewInputError } from "../src/core/ext/review-service.ts";
import type { FocusEvent } from "../src/core/ext/review-focus.ts";
import type { ExplanationEvent } from "../src/core/ext/explanations.ts";
import { addGoal, chain, harness, node } from "./helpers/ext-memory-stores.ts";

const T0 = "2026-11-04T10:00:00.000Z";

const explanation = (nodeId: string, body: string): ExplanationEvent => ({
	type: "version", nodeId, version: 1, body, author: "agent", sourceRefs: [], styleVersion: "s1", fingerprint: "f1",
	noSource: true, proposed: false, at: T0,
});

/** Alpha (a) feeds Beta (b) through one chain, so b is dialogic; the goal targets b. Gamma (c) is fixed and new. */
function layer(opts: { explanations?: ExplanationEvent[]; withLedger?: boolean } = {}) {
	const h = harness({ nodes: [node("a", "Alpha"), node("b", "Beta"), node("c", "Gamma")], chains: [chain("arg_1", ["a"], "b")], now: T0 });
	addGoal(h, "goal_1", ["b", "c"]);
	const focus: FocusEvent[] = [];
	const chats: string[] = [];
	const l = createPersonalLayer({
		...h.deps,
		dayStart: () => "2026-11-04T00:00:00.000Z",
		createReviewChat: (title) => (chats.push(title), { id: `chat_${chats.length}` }),
		...(opts.withLedger === false ? {} : { focusLedger: { append: (e: FocusEvent) => void focus.push(e), readAll: () => [...focus] } }),
		...(opts.explanations ? { explanations: { readEvents: () => opts.explanations! } } : {}),
	});
	return { h, l, focus, chats };
}

describe("startNodeSession (With the tutor)", () => {
	it("a node session is titled after its node and records a node focus, not a card focus", () => {
		const { l, chats, focus } = layer();
		const { chatId } = l.startNodeSession("c");
		assert.deepEqual(chats, ["Ask: Gamma"]);
		assert.deepEqual(focus, [{ type: "focus", chatId, nodeId: "c", at: T0 }]);
	});

	it("an unknown node is refused, and nothing is created", () => {
		const { l, chats, focus } = layer();
		assert.throws(() => l.startNodeSession("n_missing"), (e: unknown) => e instanceof ReviewInputError && e.kind === "unknown");
		assert.equal(chats.length, 0);
		assert.equal(focus.length, 0);
	});

	it("without a focus ledger a node session is refused", () => {
		const { l, chats } = layer({ withLedger: false });
		assert.throws(() => l.startNodeSession("c"), (e: unknown) => e instanceof ReviewInputError && e.kind === "invalid");
		assert.equal(chats.length, 0);
	});

	it("the tutor context of a node session carries the node, its statement and its explanation, and no card or daily-loop state", () => {
		const { l } = layer({ explanations: [explanation("c", "Gamma is the third letter.")] });
		const { chatId } = l.startNodeSession("c");
		const ctx = l.reviewToolContext(chatId, { getChat: () => null });
		assert.deepEqual(ctx.nodeFocus, { nodeId: "c", nodeName: "Gamma", nodeStatement: "Gamma holds.", explanation: "Gamma is the third letter." });
		assert.equal(ctx.focus, null);
	});

	it("a node without an explanation has no explanation in its tutor context", () => {
		const { l } = layer();
		const { chatId } = l.startNodeSession("c");
		const nodeFocus = l.reviewToolContext(chatId, { getChat: () => null }).nodeFocus;
		assert.deepEqual(nodeFocus, { nodeId: "c", nodeName: "Gamma", nodeStatement: "Gamma holds." });
		assert.equal(nodeFocus && "explanation" in nodeFocus, false);
	});

	it("a card session has a card focus and no node focus; an ordinary chat has neither", () => {
		const { l } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "What is Alpha?", answer: "Alpha holds." });
		const { chatId } = l.startReviewSession(cardId);
		const cardCtx = l.reviewToolContext(chatId, { getChat: () => null });
		assert.ok(cardCtx.focus);
		assert.equal(cardCtx.nodeFocus, null);
		const plain = l.reviewToolContext("chat_other", { getChat: () => null });
		assert.equal(plain.focus, null);
		assert.equal(plain.nodeFocus, null);
	});
});

describe("nodes without a card in today's plan", () => {
	it("a dialogic item without an active card is listed; it leaves the list once it has one", () => {
		const { l } = layer();
		const names = () => l.nodesWithoutCard().map((n) => n.nodeId).sort();
		const before = names();
		assert.ok(before.includes("b"), `dialogic b has no card: ${before.join(",")}`);
		assert.deepEqual(l.plan().withoutCard, l.nodesWithoutCard());
		l.createCard({ nodeId: "b", question: "What is Beta?", answer: "Beta holds." });
		assert.equal(names().includes("b"), false, "b leaves the list once it has an active card");
	});

	it("a fixed node that is due and has no card is listed as needing one", () => {
		const { l, h } = layer();
		h.review.appendEvent({ type: "review", nodeId: "c", channel: "fixed", rating: 3, durationSec: 20, at: "2026-10-01T10:00:00.000Z" });
		const plan = l.plan();
		assert.deepEqual(plan.needsCard.find((n) => n.nodeId === "c"), { nodeId: "c", name: "Gamma" });
		assert.ok(l.nodesWithoutCard().some((n) => n.nodeId === "c"));
	});

	it("a node with a card that is not in the plan is not listed", () => {
		const { l } = layer();
		l.createCard({ nodeId: "c", question: "What is Gamma?", answer: "Gamma holds." });
		assert.equal(l.nodesWithoutCard().some((n) => n.nodeId === "c"), false);
	});

	it("the names come from the graph", () => {
		const { l } = layer();
		const b = l.nodesWithoutCard().find((n) => n.nodeId === "b");
		assert.equal(b?.name, "Beta");
	});
});

describe("focusedNodeReviewInstructions", () => {
	const base = { nodeId: "c", nodeName: "Gamma", nodeStatement: "Gamma holds." };

	it("carry the node id, name and statement, and say this is not the daily loop", () => {
		const text = focusedNodeReviewInstructions(base);
		assert.ok(text.includes("Node id: c"));
		assert.ok(text.includes("Node: Gamma"));
		assert.ok(text.includes("Statement: Gamma holds."));
		assert.ok(text.includes("do not call next_item or record_review"));
		assert.ok(text.includes("do not ask for a rating"));
		assert.ok(text.includes("Explain the node first"));
		assert.ok(text.includes("propose_card with nodeId set to the node id above"));
		assert.notEqual(text, REVIEW_INSTRUCTIONS);
	});

	it("carry the explanation when there is one, and say so when there is none", () => {
		assert.ok(focusedNodeReviewInstructions({ ...base, explanation: "Gamma is the third letter." }).includes("Explanation: Gamma is the third letter."));
		assert.ok(focusedNodeReviewInstructions(base).includes("Explanation: none written yet"));
	});
});
