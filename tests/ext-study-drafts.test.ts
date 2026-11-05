// tests/ext-study-drafts.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickCardNode } from "../src/core/ext/study/card-node.ts";
import { deriveDrafts, dropRepeats, parseDraftEvent, processedPages, sameProposition, type DraftEvent } from "../src/core/ext/study/drafts.ts";

const AT = "2026-11-04T10:00:00.000Z";
const proposed = (draftId: string, page: number, proposition = `P ${draftId}`): DraftEvent => ({
	type: "proposed", draftId, documentId: "doc", page, proposition, question: "Q?", answer: "A.", at: AT,
});

describe("study-drafts.jsonl (REQ-study-11, REQ-study-12)", () => {
	it("a draft is pending until the first decision, which is final", () => {
		const d = deriveDrafts([
			proposed("d1", 2), proposed("d2", 3),
			{ type: "decided", draftId: "d1", decision: "approved", at: AT },
			{ type: "decided", draftId: "d1", decision: "rejected", at: AT },
		]);
		assert.deepEqual(d.map((x) => [x.id, x.status]), [["d1", "approved"], ["d2", "pending"]]);
	});
	it("a decision for an unknown draft is ignored; the first proposal of an id defines it", () => {
		const d = deriveDrafts([{ type: "decided", draftId: "zz", decision: "approved", at: AT }, proposed("d1", 2, "first"), proposed("d1", 9, "second")]);
		assert.deepEqual(d.map((x) => [x.id, x.page, x.proposition]), [["d1", 2, "first"]]);
	});
	it("collects the pages a complete run has handled, per document", () => {
		const events: DraftEvent[] = [
			{ type: "pages_processed", documentId: "doc", pages: [3, 1], at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [3, 5], at: AT },
			{ type: "pages_processed", documentId: "other", pages: [9], at: AT },
		];
		assert.deepEqual(processedPages(events, "doc"), [1, 3, 5]);
	});
	it("rejects malformed events", () => {
		for (const bad of [
			{ ...proposed("d", 1), proposition: " " },
			{ ...proposed("d", 0) },
			{ type: "decided", draftId: "d", decision: "maybe", at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [], at: AT },
			{ type: "pages_processed", documentId: "doc", pages: [1, 0], at: AT },
			{ ...proposed("d", 1), at: "x" },
		]) {
			assert.equal(parseDraftEvent(bad), null, JSON.stringify(bad));
		}
		assert.equal(parseDraftEvent(proposed("d", 1))?.type, "proposed");
	});
});

describe("dropRepeats (REQ-study-11: skip what already exists)", () => {
	it("treats case, spacing and a final full stop as no difference", () => {
		assert.equal(sameProposition("A σ-algebra is closed under complement.", "a  σ-algebra is closed\nunder complement"), true);
		assert.equal(sameProposition("A holds.", "B holds."), false);
	});
	it("drops candidates equal to an existing statement or to an earlier candidate", () => {
		const c = [
			{ page: 1, proposition: "X is closed." },
			{ page: 1, proposition: "x is closed" },
			{ page: 2, proposition: "Y is open." },
			{ page: 2, proposition: "Z is dense." },
		];
		assert.deepEqual(dropRepeats(c, ["Y is open"], 5).map((x) => x.proposition), ["X is closed.", "Z is dense."]);
	});
	it("keeps at most perPage per page, in order", () => {
		const c = [1, 2, 3, 4].map((i) => ({ page: 7, proposition: `fact ${i}` }));
		assert.deepEqual(dropRepeats(c, [], 2).map((x) => x.proposition), ["fact 1", "fact 2"]);
	});
});

describe("pickCardNode (REQ-study-09)", () => {
	const n = (id: string, statement: string, name = id, aliases: string[] = []) => ({ id, name, statement, aliases });
	it("chooses the node closest to the proposition", () => {
		const nodes = [n("n_a", "Every convergent sequence is bounded."), n("n_b", "A sigma algebra is closed under countable unions.")];
		assert.equal(pickCardNode("A sigma-algebra is closed under countable unions", nodes), "n_b");
	});
	it("uses aliases (the pipeline links equivalent phrasings to one node)", () => {
		const nodes = [n("n_a", "Totally different words here."), n("n_b", "Unrelated statement.", "n_b", ["Compact sets are closed and bounded"])];
		assert.equal(pickCardNode("compact sets are closed and bounded", nodes), "n_b");
	});
	it("a tie goes to the first node; no nodes gives null", () => {
		assert.equal(pickCardNode("zzz", [n("n_a", "qqq"), n("n_b", "www")]), "n_a");
		assert.equal(pickCardNode("anything", []), null);
	});
});
