// tests/ext-review-focus.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { focusCardOf, focusTargetOf, parseFocusEvent, type FocusEvent } from "../src/core/ext/review-focus.ts";

const T0 = "2026-11-04T10:00:00.000Z";

describe("focus events", () => {
	it("a card focus parses as before; a node focus parses with its node id", () => {
		const card = { type: "focus", chatId: "chat_1", cardId: "card_1", at: T0 };
		const node = { type: "focus", chatId: "chat_1", nodeId: "n_a", at: T0 };
		assert.deepEqual(parseFocusEvent(card), card);
		assert.deepEqual(parseFocusEvent(node), node);
	});

	it("an event names exactly one of cardId and nodeId; anything else is rejected", () => {
		const ok = { type: "focus", chatId: "chat_1", cardId: "card_1", at: T0 };
		assert.equal(parseFocusEvent({ ...ok, cardId: undefined }), null, "neither");
		assert.equal(parseFocusEvent({ ...ok, nodeId: "n_a" }), null, "both");
		assert.equal(parseFocusEvent({ ...ok, cardId: "" }), null, "empty card id");
		assert.equal(parseFocusEvent({ type: "focus", chatId: "chat_1", nodeId: "", at: T0 }), null, "empty node id");
		assert.equal(parseFocusEvent({ type: "focus", chatId: "chat_1", nodeId: 7, at: T0 }), null, "non-string node id");
	});

	it("the common fields are still required", () => {
		const ok = { type: "focus", chatId: "chat_1", nodeId: "n_a", at: T0 };
		assert.equal(parseFocusEvent({ ...ok, chatId: "" }), null);
		assert.equal(parseFocusEvent({ ...ok, at: "not a date" }), null);
		assert.equal(parseFocusEvent({ ...ok, type: "review" }), null);
		assert.equal(parseFocusEvent(null), null);
	});

	it("the last focus of a chat is its target, whether a card or a node", () => {
		const events: FocusEvent[] = [
			{ type: "focus", chatId: "c1", cardId: "card_1", at: T0 },
			{ type: "focus", chatId: "c1", nodeId: "n_a", at: T0 },
			{ type: "focus", chatId: "c2", cardId: "card_3", at: T0 },
		];
		assert.deepEqual(focusTargetOf(events, "c1"), { kind: "node", nodeId: "n_a" });
		assert.deepEqual(focusTargetOf(events, "c2"), { kind: "card", cardId: "card_3" });
		assert.equal(focusTargetOf(events, "c9"), null);
	});

	it("focusCardOf names only a card focus: a node-focused chat has no card", () => {
		const events: FocusEvent[] = [
			{ type: "focus", chatId: "c1", cardId: "card_1", at: T0 },
			{ type: "focus", chatId: "c2", nodeId: "n_a", at: T0 },
		];
		assert.equal(focusCardOf(events, "c1"), "card_1");
		assert.equal(focusCardOf(events, "c2"), null);
		assert.equal(focusCardOf(events, "c9"), null);
	});
});
