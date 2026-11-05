// tests/ext-personal-layer.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersonalLayer, startOfLocalDay } from "../src/server/ext/personal-layer.ts";
import { createPersonalPanel } from "../src/server/ext/personal-panel.ts";
import { addGoal, chain, harness, node } from "./helpers/ext-memory-stores.ts";

const T0 = "2026-11-04T10:00:00.000Z";

function layer() {
	const h = harness({ nodes: [node("a", "Alpha"), node("b", "Beta")], chains: [chain("arg_1", ["a"], "b")], now: T0 });
	addGoal(h, "goal_1", ["b"]);
	const created: string[] = [];
	const l = createPersonalLayer({
		...h.deps,
		dayStart: () => "2026-11-04T00:00:00.000Z",
		createReviewChat: (title) => (created.push(title), { id: "chat_r1" }),
	});
	return { h, l, created };
}

describe("personal layer surface", () => {
	it("starts a review session by creating a review chat", () => {
		const { l, created } = layer();
		assert.deepEqual(l.startReviewSession(), { chatId: "chat_r1" });
		assert.equal(created.length, 1);
	});

	it("plan lists names, what needs a card, and goal readiness", () => {
		const { l } = layer();
		const p = l.plan();
		assert.deepEqual(p.needsCard, [{ nodeId: "a", name: "Alpha" }]);
		assert.deepEqual(p.items.map((i) => [i.nodeId, i.name, i.channel]), [["b", "Beta", "dialogic"]]);
		assert.equal(p.goals[0]?.goalId, "goal_1");
	});

	it("creating a card makes its node plannable; approve and retire act on drafts and cards", () => {
		const { l, h } = layer();
		const { cardId } = l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.equal(l.plan().items.some((i) => i.nodeId === "a"), true);
		assert.equal(l.listCards("a").length, 1);
		assert.equal(l.listCards("b").length, 0);
		assert.throws(() => l.cardAction(cardId, "approve"), /draft/);
		l.cardAction(cardId, "retire");
		assert.equal(l.plan().items.some((i) => i.nodeId === "a"), false);
		void h;
	});

	it("mark dispatches pin, retire, channel and retention", () => {
		const { l, h } = layer();
		l.mark({ nodeId: "a", pinned: true });
		l.mark({ nodeId: "a", retired: true });
		l.mark({ nodeId: "b", channel: "fixed" });
		l.mark({ goalId: "goal_1", retention: 0.85 });
		assert.deepEqual(h.review.events.map((e) => e.type), ["pin", "retire", "retire", "pin", "channel", "retention"]);
	});

	it("builds the review tool context over the same stores", async () => {
		const { l, h } = layer();
		const ctx = l.reviewToolContext("chat_r1", { getChat: () => null });
		const item = ctx.nextItem();
		assert.equal(item.kind === "item" && item.nodeId, "b");
		ctx.record({ nodeId: "b", channel: "dialogic", rating: 3, durationSec: 60 });
		assert.equal(h.review.events.length, 1);
		const cardId = ctx.proposeCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.equal(h.cards.events[0]?.type === "created" && h.cards.events[0].status, "draft");
		assert.ok(cardId.startsWith("card_"));
	});
});

describe("startOfLocalDay", () => {
	it("is local midnight of the given instant", () => {
		const d = new Date(startOfLocalDay(new Date("2026-11-04T15:30:00")));
		assert.equal(d.getHours(), 0);
		assert.equal(d.getMinutes(), 0);
		assert.equal(d.getDate(), 4);
	});
});

describe("node panel contribution", () => {
	it("nodeReview is null for an untouched node, then reports reps, due date and marks", () => {
		const { l } = layer();
		assert.equal(l.nodeReview("a"), null);
		l.mark({ nodeId: "a", pinned: true });
		assert.deepEqual(l.nodeReview("a"), { dueAt: null, reps: 0, pinned: true, retired: false });
		l.reviewToolContext("c", { getChat: () => null }).record({ nodeId: "a", channel: "fixed", rating: 3, durationSec: 5 });
		const v = l.nodeReview("a");
		assert.equal(v?.reps, 1);
		assert.ok(v?.dueAt && Date.parse(v.dueAt) > Date.parse(T0));
	});

	it("exposes cards, review and the pin / retire / startReview handlers in the panel's shapes", () => {
		const { l, h } = layer();
		const panel = createPersonalPanel(l);
		l.createCard({ nodeId: "a", question: "Q?", answer: "A." });
		assert.deepEqual(panel.sources.cards("a"), [{ cardId: "card_t1", question: "Q?", status: "active" }]);
		panel.handlers.pin("b");
		panel.handlers.retire("a");
		assert.equal(panel.sources.review("b")?.pinned, true);
		assert.equal(panel.sources.review("a")?.retired, true);
		assert.deepEqual(panel.handlers.startReview("a"), { chatId: "chat_r1" });
		void h;
	});
});
