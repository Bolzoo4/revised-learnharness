// tests/ext-study-events.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentOfChat, deriveDocuments, parseDocumentEvent, type DocumentEvent } from "../src/core/ext/study/documents.ts";
import { deriveReading, parseReadingEvent, type ReadingEvent } from "../src/core/ext/study/reading.ts";
import { linkedPages, nodeIdsOnPages, parseStudyLinkEvent, sourcesOfNode, type StudyLinkEvent } from "../src/core/ext/study/links.ts";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const t = (s: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, s)).toISOString();

describe("documents.jsonl (REQ-study-01, REQ-study-05)", () => {
	const reg = (id: string, title: string, at = t(0)): DocumentEvent => ({ type: "registered", documentId: id, title, pageCount: 10, at });
	it("the same file registered twice is the same document; the first event wins", () => {
		const docs = deriveDocuments([reg(D1, "First"), reg(D1, "Second", t(5)), reg(D2, "Other")]);
		assert.deepEqual(docs.map((d) => [d.id, d.title]), [[D1, "First"], [D2, "Other"]]);
	});
	it("exactly one conversation per document: the first chat event wins", () => {
		const docs = deriveDocuments([
			reg(D1, "A"),
			{ type: "chat", documentId: D1, chatId: "chat_1", at: t(1) },
			{ type: "chat", documentId: D1, chatId: "chat_2", at: t(2) },
		]);
		assert.equal(docs[0]!.chatId, "chat_1");
		assert.equal(documentOfChat(docs, "chat_1")?.id, D1);
		assert.equal(documentOfChat(docs, "chat_2"), null);
	});
	it("a chat event for an unregistered document is ignored", () => {
		assert.deepEqual(deriveDocuments([{ type: "chat", documentId: D1, chatId: "c", at: t(0) }]), []);
	});
	it("rejects malformed events", () => {
		const ok = { type: "registered", documentId: D1, title: " A ", pageCount: 3, at: t(0) };
		assert.deepEqual(parseDocumentEvent(ok), { type: "registered", documentId: D1, title: "A", pageCount: 3, at: t(0) });
		for (const bad of [
			{ ...ok, documentId: "xyz" },
			{ ...ok, documentId: "ABCDEF".repeat(11).slice(0, 64) },
			{ ...ok, title: "  " },
			{ ...ok, pageCount: 0 },
			{ ...ok, pageCount: 2.5 },
			{ ...ok, at: "yesterday" },
			{ type: "chat", documentId: D1, chatId: "", at: t(0) },
			{ type: "other", documentId: D1, at: t(0) },
			null,
		]) {
			assert.equal(parseDocumentEvent(bad), null, JSON.stringify(bad));
		}
	});
});

describe("reading.jsonl (REQ-study-03)", () => {
	const visit = (page: number, s: number, documentId = D1): ReadingEvent => ({ type: "visit", documentId, page, at: t(s) });
	const close = (s: number, documentId = D1): ReadingEvent => ({ type: "close", documentId, at: t(s) });

	it("restores the last page visited", () => {
		assert.deepEqual(deriveReading([visit(3, 0), visit(7, 2)], D1).lastPage, 7);
		assert.equal(deriveReading([], D1).lastPage, null);
	});
	it("a page is read after the dwell time (default 5 s) and not before", () => {
		const s = deriveReading([visit(1, 0), visit(2, 4), visit(3, 9), close(30)], D1);
		assert.deepEqual(s.readPages, [2, 3]); // page 1: 4 s, page 2: 5 s (boundary counts), page 3: 21 s
	});
	it("the newest visit has no end yet and is not read until something follows it", () => {
		assert.deepEqual(deriveReading([visit(1, 0)], D1).readPages, []);
		assert.deepEqual(deriveReading([visit(1, 0), close(60)], D1).readPages, [1]);
	});
	it("a close ends the visit, so time after the close does not count for the next visit's page", () => {
		const s = deriveReading([visit(1, 0), close(1), visit(2, 100)], D1);
		assert.deepEqual(s.readPages, []);
		assert.equal(s.lastPage, 2);
	});
	it("other documents' events do not interrupt or count", () => {
		const s = deriveReading([visit(1, 0), visit(9, 2, D2), close(8, D2), visit(4, 12)], D1);
		assert.deepEqual(s.readPages, [1]);
	});
	it("honours a custom dwell and ignores pages beyond the page count", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 2), close(3)], D1, { dwellSeconds: 2 }).readPages, [1]);
		const s = deriveReading([visit(50, 0), visit(2, 10), close(20)], D1, { pageCount: 10 });
		assert.deepEqual(s.readPages, [2]);
		assert.equal(deriveReading([visit(50, 0)], D1, { pageCount: 10 }).lastPage, null);
	});
	it("a clock that went backwards never counts as dwell", () => {
		assert.deepEqual(deriveReading([visit(1, 30), visit(2, 0), close(1)], D1).readPages, []);
	});
	it("rejects malformed events", () => {
		for (const bad of [{ type: "visit", documentId: D1, page: 0, at: t(0) }, { type: "visit", documentId: "", page: 1, at: t(0) }, { type: "close", documentId: D1, at: "x" }, { type: "move" }, 3]) {
			assert.equal(parseReadingEvent(bad), null, JSON.stringify(bad));
		}
		assert.deepEqual(parseReadingEvent({ type: "close", documentId: D1, at: t(0) }), { type: "close", documentId: D1, at: t(0) });
	});
});

describe("study-links.jsonl (REQ-study-10)", () => {
	const link = (nodeId: string, documentId: string, page: number): StudyLinkEvent => ({ type: "link", nodeId, documentId, page, at: t(0) });
	const events = [link("n_a", D1, 3), link("n_a", D1, 3), link("n_a", D2, 1), link("n_b", D1, 3), link("n_c", D1, 8)];
	it("lists the distinct sources of a node in order of first appearance", () => {
		assert.deepEqual(sourcesOfNode(events, "n_a"), [{ documentId: D1, page: 3 }, { documentId: D2, page: 1 }]);
		assert.deepEqual(sourcesOfNode(events, "n_zzz"), []);
	});
	it("lists the pages of a document that have nodes, and the nodes on given pages", () => {
		assert.deepEqual(linkedPages(events, D1), [3, 8]);
		assert.deepEqual(nodeIdsOnPages(events, D1, [3]), ["n_a", "n_b"]);
		assert.deepEqual(nodeIdsOnPages(events, D1, [4]), []);
	});
	it("rejects malformed events", () => {
		assert.equal(parseStudyLinkEvent({ type: "link", nodeId: "n", documentId: D1, page: 0, at: t(0) }), null);
		assert.equal(parseStudyLinkEvent({ type: "link", nodeId: "", documentId: D1, page: 1, at: t(0) }), null);
		assert.deepEqual(parseStudyLinkEvent(link("n", D1, 2)), link("n", D1, 2));
	});
});
