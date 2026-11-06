// tests/ext-review-cards.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersonalLayer } from "../src/server/ext/personal-layer.ts";
import { focusCardOf, parseFocusEvent, type FocusEvent } from "../src/core/ext/review-focus.ts";
import { focusedReviewInstructions, REVIEW_INSTRUCTIONS } from "../src/agent/ext/review-instructions.ts";
import { ReviewInputError } from "../src/core/ext/review-service.ts";
import { addGoal, chain, harness, node } from "./helpers/ext-memory-stores.ts";

const T0 = "2026-11-04T10:00:00.000Z";

/** Alpha (a) feeds Beta (b) through one chain, so b is dialogic; the goal targets b. */
function layer() {
	const h = harness({ nodes: [node("a", "Alpha"), node("b", "Beta")], chains: [chain("arg_1", ["a"], "b")], now: T0 });
	addGoal(h, "goal_1", ["b"]);
	const focus: FocusEvent[] = [];
	const chats: string[] = [];
	const l = createPersonalLayer({
		...h.deps,
		dayStart: () => "2026-11-04T00:00:00.000Z",
		createReviewChat: (title) => (chats.push(title), { id: `chat_${chats.length}` }),
		focusLedger: { append: (e) => void focus.push(e), readAll: () => [...focus] },
	});
	return { h, l, focus, chats };
}

describe("focus ledger", () => {
	it("parses a focus event and rejects anything else", () => {
		const ok = { type: "focus", chatId: "chat_1", cardId: "card_1", at: T0 };
		assert.deepEqual(parseFocusEvent(ok), ok);
		assert.equal(parseFocusEvent({ ...ok, chatId: "" }), null);
		assert.equal(parseFocusEvent({ ...ok, cardId: undefined }), null);
		assert.equal(parseFocusEvent({ ...ok, at: "not a date" }), null);
		assert.equal(parseFocusEvent({ ...ok, type: "review" }), null);
		assert.equal(parseFocusEvent(null), null);
	});

	it("the last focus event of a chat wins; an unfocused chat has no card", () => {
		const events: FocusEvent[] = [
			{ type: "focus", chatId: "c1", cardId: "card_1", at: T0 },
			{ type: "focus", chatId: "c1", cardId: "card_2", at: T0 },
			{ type: "focus", chatId: "c2", cardId: "card_3", at: T0 },
		];
		assert.equal(focusCardOf(events, "c1"), "card_2");
		assert.equal(focusCardOf(events, "c9"), null);
	});
});

describe("ask the tutor (focused review session)", () => {
	it("a session without a card is the daily review, as before", () => {
		const { l, chats, focus } = layer();
		assert.deepEqual(l.startReviewSession(), { chatId: "chat_1" });
		assert.deepEqual(chats, ["Daily review"]);
		assert.equal(focus.length, 0);
	});

	it("a session with a card is titled after its node and records the focus", () => {
		const { l, chats, focus } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "What is Alpha?", answer: "Alpha holds." });
		const { chatId } = l.startReviewSession(cardId);
		assert.deepEqual(chats, ["Ask: Alpha"]);
		assert.deepEqual(focus, [{ type: "focus", chatId, cardId, at: T0 }]);
	});

	it("the tutor's context for that chat carries the card and the node; other chats get none", () => {
		const { l } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "What is Alpha?", answer: "Alpha holds." });
		const { chatId } = l.startReviewSession(cardId);
		assert.deepEqual(l.reviewToolContext(chatId, { getChat: () => null }).focus, {
			nodeName: "Alpha",
			nodeStatement: "Alpha holds.",
			question: "What is Alpha?",
			answer: "Alpha holds.",
		});
		assert.equal(l.reviewToolContext("chat_other", { getChat: () => null }).focus, null);
	});

	it("an unknown card is refused, and nothing is created", () => {
		const { l, chats, focus } = layer();
		assert.throws(() => l.startReviewSession("card_missing"), (e: unknown) => e instanceof ReviewInputError && e.kind === "unknown");
		assert.equal(chats.length, 0);
		assert.equal(focus.length, 0);
	});

	it("without a focus ledger a card session is refused", () => {
		const h = harness({ nodes: [node("a", "Alpha")], now: T0 });
		const l = createPersonalLayer({ ...h.deps, createReviewChat: () => ({ id: "chat_1" }) });
		const { cardId } = l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.throws(() => l.startReviewSession(cardId), (e: unknown) => e instanceof ReviewInputError && e.kind === "invalid");
		assert.equal(l.reviewToolContext("chat_1", { getChat: () => null }).focus, null);
	});

	it("the focused instructions carry the card and say this is not the daily loop", () => {
		const text = focusedReviewInstructions({ nodeName: "Alpha", nodeStatement: "Alpha holds.", question: "What is Alpha?", answer: "Alpha holds." });
		assert.ok(text.includes("Card question: What is Alpha?"));
		assert.ok(text.includes("Card answer: Alpha holds."));
		assert.ok(text.includes("do not call next_item or record_review"));
		assert.ok(text.includes("Explain the concept first"));
		assert.notEqual(text, REVIEW_INSTRUCTIONS);
	});
});

describe("review the card (answer)", () => {
	it("the plan carries the card to show for each fixed item, and the planned seconds", () => {
		const { l } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "What is Alpha?", answer: "Alpha holds." });
		const p = l.plan();
		const fixed = p.items.find((i) => i.nodeId === "a");
		assert.equal(fixed?.channel, "fixed");
		assert.deepEqual(fixed && "card" in fixed ? fixed.card : null, { cardId, question: "What is Alpha?", answer: "Alpha holds." });
		assert.equal(p.plannedSec, p.items.reduce((s, i) => s + (i.channel === "fixed" ? 20 : 180), 0), "default costs before any review");
	});

	it("a rating of a card item is recorded as a fixed review, through the same recording as the agent", () => {
		const { l, h } = layer();
		l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		const res = l.answerCard({ nodeId: "a", rating: 3, durationSec: 20 });
		assert.ok(res.dueAt);
		const last = h.review.events.at(-1);
		assert.equal(last?.type === "review" && last.channel, "fixed");
		assert.equal(last?.type === "review" && last.rating, 3);
		assert.equal(last?.type === "review" && last.durationSec, 20);
	});

	it("an item is answered once: the same node is no longer due after its review", () => {
		const { l } = layer();
		l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		l.answerCard({ nodeId: "a", rating: 4, durationSec: 5 });
		assert.equal(l.plan().items.some((i) => i.nodeId === "a"), false);
		assert.throws(() => l.answerCard({ nodeId: "a", rating: 4, durationSec: 5 }), (e: unknown) => e instanceof ReviewInputError && e.kind === "invalid");
	});

	it("a node that is not a card item of today's plan is refused and nothing is written", () => {
		const { l, h } = layer();
		// a has no card yet: not a card item. b is dialogic: a conversation, not a card.
		assert.throws(() => l.answerCard({ nodeId: "a", rating: 3, durationSec: 5 }), /not a card item of today's plan/);
		assert.throws(() => l.answerCard({ nodeId: "b", rating: 3, durationSec: 5 }), /not a card item of today's plan/);
		assert.equal(h.review.events.length, 0);
	});
});
