// tests/ext-review-stores.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveCards } from "../src/core/ext/cards.ts";
import { createCardsStore } from "../src/store/ext/cards-store.ts";
import { extPathsFor } from "../src/store/ext/paths.ts";
import { createReviewStore } from "../src/store/ext/review-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const AT = "2026-11-04T10:00:00.000Z";

describe("review and cards stores", () => {
	it("paths place review.jsonl and cards.jsonl under <dataRoot>/ext", () => {
		const p = extPathsFor("/tmp/lh-data");
		assert.equal(p.review, path.join("/tmp/lh-data", "ext", "review.jsonl"));
		assert.equal(p.cards, path.join("/tmp/lh-data", "ext", "cards.jsonl"));
	});

	it("review events persist to review.jsonl and read back in order", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		store.appendEvent({ type: "review", nodeId: "n_1", channel: "fixed", rating: 3, durationSec: 9, at: AT });
		store.appendEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT });
		const events = createReviewStore(dir).readEvents();
		assert.equal(events.length, 2);
		assert.deepEqual(events.map((e) => e.type), ["review", "pin"]); // TEMP until Task 5: deriveMarks
		assert.equal(fs.readFileSync(path.join(dir, "review.jsonl"), "utf-8").trim().split("\n").length, 2);
	});

	it("rejects an invalid event without writing", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		assert.throws(() => store.appendEvent({ type: "review", nodeId: "n_1", channel: "fixed", rating: 9 as never, durationSec: 1, at: AT }), /rejected/);
		assert.equal(fs.existsSync(path.join(dir, "review.jsonl")), false);
	});

	it("cards persist and an agent card cannot be written active", () => {
		const dir = tmp();
		const store = createCardsStore(dir);
		store.appendEvent({ type: "created", cardId: "card_1", nodeId: "n_1", question: "Q", answer: "A", author: "agent", status: "draft", at: AT });
		assert.throws(
			() => store.appendEvent({ type: "created", cardId: "card_2", nodeId: "n_1", question: "Q", answer: "A", author: "agent", status: "active", at: AT }),
			/rejected/,
		);
		assert.deepEqual(deriveCards(createCardsStore(dir).readEvents()).map((c) => c.id), ["card_1"]);
	});

	it("skips a corrupt line instead of failing", () => {
		const dir = tmp();
		const store = createReviewStore(dir);
		store.appendEvent({ type: "pin", nodeId: "n_1", pinned: true, at: AT });
		fs.appendFileSync(path.join(dir, "review.jsonl"), "{not json\n");
		store.appendEvent({ type: "pin", nodeId: "n_2", pinned: true, at: AT });
		assert.equal(createReviewStore(dir).readEvents().length, 2);
	});
});
