// tests/ext-study-complete.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { deriveDrafts } from "../src/core/ext/study/drafts.ts";
import { COMPLETE_BATCH_PAGES, MAX_DRAFTS_PER_PAGE, StudyError } from "../src/server/ext/study-service.ts";
import { readPages, registerA, studyHarness } from "./helpers/study-fakes.ts";

const draft = (page: number, n: number) => ({ page, proposition: `Fact ${n} on page ${page}.`, question: `Q${n}?`, answer: `A${n}.` });

describe("complete (REQ-study-11, REQ-study-12)", () => {
	it("proposes drafts only for pages read and not yet processed, and writes no node, link or card", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1), draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2, 4]);
		h.svc.recordReading({ documentId: id, kind: "visit", page: 5 }); // visited but not read (no dwell)
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 2, pages: [2, 4], remaining: 0, ceilingReached: false, providerLimited: false });
		assert.deepEqual(h.pageCalls[0]!.pages.map((p) => p.page), [2, 4]);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => [d.page, d.status]), [[2, "pending"], [4, "pending"]]);
		assert.deepEqual([h.imports.length, h.links.events.length, h.cards.created.length, h.cards.proposed.length, h.cards.pinned.length], [0, 0, 0, 0, 0]);
	});
	it("a second run does not offer the same pages again", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await h.svc.complete(id);
		const again = await h.svc.complete(id);
		assert.deepEqual(again, { proposed: 0, pages: [], remaining: 0, ceilingReached: false, providerLimited: false });
		assert.equal(h.pageCalls.length, 1);
	});
	it("a page read later is offered by the next run", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)], [draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await h.svc.complete(id);
		readPages(h, id, [4]);
		const r = await h.svc.complete(id);
		assert.deepEqual(r.pages, [4]);
	});
	it("tells the model what already exists on those pages and drops proposals that repeat it", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1), { page: 2, proposition: "A sigma algebra is closed under complement.", question: "Q?", answer: "A." }, draft(2, 3)]] });
		const id = await registerA(h);
		h.pipeline.next = [{ id: "n_have", name: "Have", statement: "A sigma algebra is closed under complement", aliases: [] }];
		await h.svc.confirmCard({ documentId: id, page: 2, proposition: "A sigma algebra is closed under complement.", question: "Q?", answer: "A." });
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.deepEqual(h.pageCalls[0]!.known, [{ page: 2, statement: "A sigma algebra is closed under complement" }]);
		assert.equal(r.proposed, 2);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.proposition), ["Fact 1 on page 2.", "Fact 3 on page 2."]);
	});
	it("ignores proposals for pages outside the batch and keeps at most five per page", async () => {
		const many = Array.from({ length: MAX_DRAFTS_PER_PAGE + 3 }, (_, i) => draft(2, i + 1));
		const h = studyHarness({ proposals: [[...many, draft(5, 99)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.equal(r.proposed, MAX_DRAFTS_PER_PAGE);
		assert.equal(h.svc.listDrafts(id).every((d) => d.page === 2), true);
	});
	it("a page with no text is marked processed without calling the model", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		readPages(h, id, [3]); // page 3 is empty in the fixture
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [3], remaining: 0, ceilingReached: false, providerLimited: false });
		assert.equal(h.pageCalls.length, 0);
	});
	it("sends pages in batches", async () => {
		const pages = Array.from({ length: 10 }, (_, i) => `Text of page ${i + 1}.`);
		const h = studyHarness({ pages, proposals: [[], [], []] });
		const id = await registerA(h);
		readPages(h, id, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const r = await h.svc.complete(id);
		assert.deepEqual(h.pageCalls.map((c) => c.pages.length), [COMPLETE_BATCH_PAGES, COMPLETE_BATCH_PAGES, 1]);
		assert.equal(r.pages.length, 9);
	});
	it("nothing read means nothing to do", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.deepEqual(await h.svc.complete(id), { proposed: 0, pages: [], remaining: 0, ceilingReached: false, providerLimited: false });
	});
});

describe("complete and the daily ceiling (REQ-study-13)", () => {
	it("does not call the model when the ceiling is already reached, and leaves the pages unprocessed", async () => {
		const h = studyHarness({ proposals: [[draft(2, 1)]] });
		const id = await registerA(h);
		readPages(h, id, [2]);
		h.gate.open = false;
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [], remaining: 1, ceilingReached: true, providerLimited: false });
		assert.equal(h.pageCalls.length, 0);
		h.gate.open = true;
		assert.equal((await h.svc.complete(id)).proposed, 1);
	});
	it("stops between batches when the ceiling is reached mid-run and keeps what was done", async () => {
		const pages = Array.from({ length: 8 }, (_, i) => `Text of page ${i + 1}.`);
		const gateRef: { close: () => void } = { close: () => {} };
		const h = studyHarness({ pages, proposals: [[draft(1, 1)], [draft(5, 2)]], onPropose: () => gateRef.close() });
		gateRef.close = () => void (h.gate.open = false); // the first batch spends the rest of the day
		const id = await registerA(h);
		readPages(h, id, [1, 2, 3, 4, 5, 6]);
		const r = await h.svc.complete(id);
		assert.deepEqual([r.pages, r.remaining, r.ceilingReached, r.proposed], [[1, 2, 3, 4], 2, true, 1]);
	});
	it("a CostCeilingError from the writer ends the run cleanly without marking the batch processed", async () => {
		const h = studyHarness({ proposals: () => Promise.reject(new CostCeilingError("spent")) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const r = await h.svc.complete(id);
		assert.deepEqual(r, { proposed: 0, pages: [], remaining: 1, ceilingReached: true, providerLimited: false });
		assert.equal(h.drafts.events.length, 0);
	});
	it("any other writer failure propagates and marks nothing", async () => {
		const h = studyHarness({ proposals: () => Promise.reject(new Error("boom")) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		await assert.rejects(h.svc.complete(id), (e: unknown) => e instanceof StudyError && e.status === 502 && !e.message.includes("boom"));
		assert.equal(h.drafts.events.length, 0);
	});
	it("refuses a second run while one is in progress", async () => {
		let release!: () => void;
		const gateOpen = new Promise<void>((r) => (release = r));
		const h = studyHarness({ proposals: () => gateOpen.then(() => []) });
		const id = await registerA(h);
		readPages(h, id, [2]);
		const first = h.svc.complete(id);
		await assert.rejects(h.svc.complete(id), (e: unknown) => e instanceof StudyError && e.status === 409);
		release();
		await first;
		assert.equal((await h.svc.complete(id)).pages.length, 0);
	});
});

describe("deciding drafts (REQ-study-11, REQ-study-12)", () => {
	async function withDrafts() {
		const h = studyHarness({ proposals: [[draft(2, 1), draft(4, 2)]] });
		const id = await registerA(h);
		readPages(h, id, [2, 4]);
		await h.svc.complete(id);
		const [d1, d2] = h.svc.listDrafts(id);
		return { h, id, d1: d1!, d2: d2! };
	}
	it("approving an unedited draft creates an agent card that is then approved, attached to a node linked to the page", async () => {
		const { h, d1 } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }], reject: [] });
		assert.equal(r.approved.length, 1);
		assert.equal(h.imports[0]!.text, d1.proposition);
		assert.deepEqual(h.cards.proposed, [{ nodeId: r.approved[0]!.nodeId, question: d1.question, answer: d1.answer }]);
		assert.deepEqual(h.cards.approved, [r.approved[0]!.cardId]);
		assert.deepEqual(h.cards.created, []);
		assert.deepEqual(h.links.events.map((e) => e.page), [2]);
		assert.equal(deriveDrafts(h.drafts.events).find((d) => d.id === d1.id)!.status, "approved");
	});
	it("an edited draft becomes a user card with the edited text", async () => {
		const { h, d1 } = await withDrafts();
		await h.svc.decideDrafts({ approve: [{ draftId: d1.id, question: "A better question?" }], reject: [] });
		assert.deepEqual(h.cards.created, [{ nodeId: "n_1", question: "A better question?", answer: d1.answer }]);
		assert.deepEqual(h.cards.proposed, []);
	});
	it("rejecting writes only a decision; a decided draft cannot be decided again", async () => {
		const { h, id, d1, d2 } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [], reject: [d1.id] });
		assert.deepEqual(r.rejected, [d1.id]);
		assert.equal(h.imports.length, 0);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.id), [d2.id]);
		const again = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }], reject: [d1.id] });
		assert.deepEqual(again.failed.map((f) => f.error), ["not a pending draft", "not a pending draft"]);
		assert.equal(h.imports.length, 0);
	});
	it("one failing approval does not stop the others and leaves its draft pending", async () => {
		const { h, id, d1, d2 } = await withDrafts();
		h.pipeline.next = [];
		const r = await h.svc.decideDrafts({ approve: [{ draftId: d1.id }, { draftId: d2.id }], reject: [] });
		assert.equal(r.failed.length, 1);
		assert.match(r.failed[0]!.error, /found no proposition/);
		assert.equal(r.approved.length, 1);
		assert.deepEqual(h.svc.listDrafts(id).map((d) => d.id), [d1.id]);
	});
	it("an unknown draft id fails without effect", async () => {
		const { h } = await withDrafts();
		const r = await h.svc.decideDrafts({ approve: [{ draftId: "draft_nope" }], reject: ["draft_nope2"] });
		assert.equal(r.failed.length, 2);
		assert.equal(h.imports.length, 0);
	});
});