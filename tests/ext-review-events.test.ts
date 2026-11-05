// tests/ext-review-events.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveCards, parseCardEvent, pickVariant, type CardEvent } from "../src/core/ext/cards.ts";
import { parseReviewEvent } from "../src/core/ext/review.ts";

const AT = "2026-11-04T10:00:00.000Z";

describe("parseReviewEvent", () => {
	const base = { type: "review", nodeId: "n_1", channel: "fixed", rating: 3, durationSec: 12, at: AT };

	it("accepts a valid review of each channel", () => {
		for (const channel of ["fixed", "dialogic", "exercise"]) {
			assert.ok(parseReviewEvent({ ...base, channel }));
		}
	});

	it("rejects bad rating, channel, duration, time", () => {
		assert.equal(parseReviewEvent({ ...base, rating: 5 }), null);
		assert.equal(parseReviewEvent({ ...base, rating: 0 }), null);
		assert.equal(parseReviewEvent({ ...base, channel: "magic" }), null);
		assert.equal(parseReviewEvent({ ...base, durationSec: -1 }), null);
		assert.equal(parseReviewEvent({ ...base, durationSec: Number.NaN }), null);
		assert.equal(parseReviewEvent({ ...base, at: "yesterday" }), null);
		assert.equal(parseReviewEvent({ ...base, nodeId: "" }), null);
	});

	it("only a dialogic review may carry weak premises (REQ-pl-15)", () => {
		assert.ok(parseReviewEvent({ ...base, channel: "dialogic", weakPremises: ["n_2"] }));
		assert.equal(parseReviewEvent({ ...base, channel: "fixed", weakPremises: ["n_2"] }), null);
		assert.equal(parseReviewEvent({ ...base, channel: "dialogic", weakPremises: [""] }), null);
	});

	it("parses implicit, pin, retire, channel and retention events", () => {
		assert.ok(parseReviewEvent({ type: "implicit", nodeId: "n_2", viaNodeId: "n_1", outcome: "credit", at: AT }));
		assert.equal(parseReviewEvent({ type: "implicit", nodeId: "n_2", viaNodeId: "n_1", outcome: "meh", at: AT }), null);
		assert.ok(parseReviewEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT }));
		assert.ok(parseReviewEvent({ type: "retire", nodeId: "n_1", retired: false, at: AT }));
		assert.ok(parseReviewEvent({ type: "channel", nodeId: "n_1", channel: null, at: AT }));
		assert.equal(parseReviewEvent({ type: "channel", nodeId: "n_1", channel: "exercise", at: AT }), null);
		assert.ok(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.85, at: AT }));
		assert.equal(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.99, at: AT }), null);
		assert.equal(parseReviewEvent({ type: "retention", goalId: "goal_a", retention: 0.5, at: AT }), null);
		assert.equal(parseReviewEvent(null), null);
		assert.equal(parseReviewEvent({ type: "unknown", at: AT }), null);
	});
});

describe("cards", () => {
	const created = (over: Partial<CardEvent & { type: "created" }>): unknown => ({
		type: "created", cardId: "card_1", nodeId: "n_1", question: "Q?", answer: "A.", author: "user", status: "active", at: AT, ...over,
	});

	it("an agent card must be born a draft (REQ-pl-03)", () => {
		assert.ok(parseCardEvent(created({ author: "agent", status: "draft" })));
		assert.equal(parseCardEvent(created({ author: "agent", status: "active" })), null);
		assert.ok(parseCardEvent(created({ author: "user", status: "active" })));
		assert.equal(parseCardEvent(created({ question: "" })), null);
	});

	it("derives the latest status and ignores strays", () => {
		const events: CardEvent[] = [
			parseCardEvent(created({ author: "agent", status: "draft" }))!,
			{ type: "status", cardId: "card_1", status: "active", at: AT },
			{ type: "status", cardId: "ghost", status: "retired", at: AT },
			parseCardEvent(created({ cardId: "card_1", question: "dup" }))!,
		];
		const cards = deriveCards(events);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]?.status, "active");
		assert.equal(cards[0]?.question, "Q?");
	});

	it("variants of a node rotate; drafts and retired variants never show (REQ-pl-01)", () => {
		const mk = (cardId: string, status: "draft" | "active", author: "user" | "agent" = "user") =>
			parseCardEvent(created({ cardId, status, author }))!;
		const cards = deriveCards([
			mk("c1", "active"),
			mk("c2", "active"),
			parseCardEvent(created({ cardId: "c3", author: "agent", status: "draft" }))!,
			mk("c4", "active"),
			{ type: "status", cardId: "c4", status: "retired", at: AT },
		]);
		assert.deepEqual([0, 1, 2, 3].map((n) => pickVariant(cards, "n_1", n)?.id), ["c1", "c2", "c1", "c2"]);
		assert.equal(pickVariant(cards, "n_other", 0), undefined);
	});
});
