// tests/ext-study-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeStudyContext } from "../src/core/ext/study/context.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { StudyError } from "../src/server/ext/study-service.ts";
import { BOOK_PAGES, idOf, PDF_A, PDF_B, readPages, registerA, studyHarness } from "./helpers/study-fakes.ts";

const rejectsWith = (p: Promise<unknown>, status: number, re: RegExp) =>
	assert.rejects(p, (e: unknown) => e instanceof StudyError && e.status === status && re.test(e.message));

describe("registering a document (REQ-study-01, REQ-study-02)", () => {
	it("stores a copy, records sha256 id, title and page count, and writes the page texts", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		assert.equal(doc.id, idOf(PDF_A));
		assert.equal(doc.title, "a");
		assert.equal(doc.pageCount, BOOK_PAGES.length);
		assert.equal(h.files.pdfs.has(doc.id), true);
		assert.deepEqual(h.files.pages.get(doc.id), BOOK_PAGES);
		assert.deepEqual(h.documents.events.map((e) => e.type), ["registered"]);
	});
	it("the same file is the same document: no second event, no second copy", async () => {
		const h = studyHarness();
		const a = await h.svc.registerDocument({ path: "/books/a.pdf" });
		h.byte.files.set("/elsewhere/copy.pdf", PDF_A);
		const b = await h.svc.registerDocument({ path: "/elsewhere/copy.pdf", title: "Other name" });
		assert.equal(b.id, a.id);
		assert.equal(b.title, "a");
		assert.equal(h.documents.events.length, 1);
		assert.equal(h.files.pdfs.size, 1);
	});
	it("a custom title is used for a new document", async () => {
		const h = studyHarness();
		assert.equal((await h.svc.registerDocument({ path: "/books/b.pdf", title: "  Probability  " })).title, "Probability");
	});
	it("registers the stored copy as an ACTIVE PRIMARY source, once", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		await h.svc.registerDocument({ path: "/books/a.pdf" });
		const entries = h.library.list();
		assert.equal(entries.length, 1);
		assert.deepEqual(
			[entries[0]!.kind, entries[0]!.locator, entries[0]!.tier, entries[0]!.status, entries[0]!.label],
			["pdf", `/data/ext/documents/${doc.id}.pdf`, "primary", "active", "a"],
		);
	});
	it("promotes a source entry that was only proposed", async () => {
		const h = studyHarness();
		const doc = await h.svc.registerDocument({ path: "/books/a.pdf" });
		const entry = h.library.list()[0]!;
		h.library.setStatus(entry.id, "proposed", "secondary");
		await h.svc.open(doc.id);
		assert.deepEqual([h.library.list()[0]!.status, h.library.list()[0]!.tier], ["active", "primary"]);
	});
	it("refuses a relative path, a non-pdf name, an unreadable file, a non-PDF and an oversized file", async () => {
		const h = studyHarness();
		await rejectsWith(h.svc.registerDocument({ path: "books/a.pdf" }), 400, /absolute path/);
		await rejectsWith(h.svc.registerDocument({ path: "/books/a.txt" }), 400, /absolute path/);
		await rejectsWith(h.svc.registerDocument({ path: "/books/missing.pdf" }), 404, /cannot be read/);
		h.byte.files.set("/books/fake.pdf", new TextEncoder().encode("hello"));
		await rejectsWith(h.svc.registerDocument({ path: "/books/fake.pdf" }), 400, /not a PDF/);
		const small = studyHarness({ maxPdfBytes: 10 });
		await rejectsWith(small.svc.registerDocument({ path: "/books/a.pdf" }), 400, /too large/);
		assert.equal(h.documents.events.length, 0);
	});
	it("refuses a PDF with no extractable text (a scan) and writes no event", async () => {
		const h = studyHarness({ pages: ["", "  ", ""] });
		await rejectsWith(h.svc.registerDocument({ path: "/books/a.pdf" }), 422, /no extractable text/);
		assert.equal(h.documents.events.length, 0);
		assert.equal(h.library.list().length, 0);
	});
	it("lists documents with the reading summary", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await h.svc.registerDocument({ path: "/books/b.pdf" });
		readPages(h, id, [2, 4]);
		const list = h.svc.listDocuments();
		assert.deepEqual(list.map((d) => [d.title, d.lastPage, d.readCount]), [["a", 4, 2], ["b", null, 0]]);
		assert.notEqual(list[0]!.id, idOf(PDF_B));
	});
});

describe("one conversation per document (REQ-study-05)", () => {
	it("the first open creates a study chat, every later open returns the same one", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const first = await h.svc.open(id);
		const second = await h.svc.open(id);
		assert.equal(first.chatId, second.chatId);
		assert.deepEqual(h.chats, ["Study: a"]);
		assert.equal(h.documents.events.filter((e) => e.type === "chat").length, 1);
	});
	it("two documents have two conversations; an unknown document is a 404", async () => {
		const h = studyHarness();
		const a = await registerA(h);
		const b = (await h.svc.registerDocument({ path: "/books/b.pdf" })).id;
		assert.notEqual((await h.svc.open(a)).chatId, (await h.svc.open(b)).chatId);
		await rejectsWith(h.svc.open("f".repeat(64)), 404, /unknown document/);
	});
	it("re-extracts the page texts on open when the file was lost", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.files.pages.clear();
		h.restart();
		await h.svc.open(id);
		assert.deepEqual(h.files.pages.get(id), BOOK_PAGES);
	});
});

describe("reading position (REQ-study-03)", () => {
	it("resumes on the last page visited and reports the pages read", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.equal((await h.svc.open(id)).page, 1);
		readPages(h, id, [2, 3]);
		h.svc.recordReading({ documentId: id, kind: "visit", page: 5 });
		const open = await h.svc.open(id);
		assert.equal(open.page, 5);
		assert.deepEqual(open.readPages, [2, 3]);
	});
	it("refuses a page outside the document and an unknown document", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		for (const page of [0, 6, 1.5, "2", undefined]) assert.throws(() => h.svc.recordReading({ documentId: id, kind: "visit", page }), /page must be a whole number from 1 to 5/, String(page));
		assert.throws(() => h.svc.recordReading({ documentId: "e".repeat(64), kind: "close" }), /unknown document/);
		assert.equal(h.reading.events.length, 0);
	});
});

describe("the conversation's tool context (REQ-study-06, REQ-study-07)", () => {
	it("finds the document by chat id and serves page text and search", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const { chatId } = await h.svc.open(id);
		const ctx = h.svc.toolContext(chatId, { getChat: () => ({ messages: [newUserMessage(encodeStudyContext({ documentId: id, page: 2, selection: "" }, "q"))] }) });
		assert.deepEqual(ctx.document(), { id, title: "a", pageCount: 5 });
		assert.equal(ctx.pageText(2), BOOK_PAGES[1]);
		assert.equal(ctx.pageText(0), null);
		assert.equal(ctx.pageText(6), null);
		assert.deepEqual(ctx.search("SIGMA").map((x) => x.page), [2]);
		assert.match(ctx.search("bounded")[0]!.snippet, /Every convergent sequence is bounded/);
		assert.deepEqual(ctx.search("  "), []);
	});
	it("an unknown chat has no document", () => {
		const h = studyHarness();
		const ctx = h.svc.toolContext("chat_x", { getChat: () => null });
		assert.equal(ctx.document(), null);
		assert.equal(ctx.pageText(1), null);
		assert.deepEqual(ctx.search("a"), []);
	});
});

describe("drafting a card (REQ-study-08)", () => {
	it("drafts from the selection when there is one, otherwise from the page", async () => {
		const h = studyHarness({ cardDraft: { proposition: "Sigma algebras are closed under complement.", question: "Q?", answer: "A." } });
		const id = await registerA(h);
		const d = await h.svc.draftCard({ documentId: id, page: 2, selection: "  closed under complement " });
		assert.equal(d.proposition, "Sigma algebras are closed under complement.");
		await h.svc.draftCard({ documentId: id, page: 2 });
		assert.deepEqual(h.cardCalls.map((c) => [c.from, c.text, c.page, c.title]), [
			["selection", "closed under complement", 2, "a"],
			["page", BOOK_PAGES[1], 2, "a"],
		]);
	});
	it("a page without text and no selection cannot be drafted; a huge selection is refused", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 3 }), 422, /no text/);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 2, selection: "x".repeat(6001) }), 400, /select less text/);
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 9 }), 400, /page must be/);
	});
	it("a model failure is a 502 with a plain message", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.fail.draft = true;
		await rejectsWith(h.svc.draftCard({ documentId: id, page: 2 }), 502, /could not draft a card: model unavailable/);
	});
});

describe("confirming a card (REQ-study-09, REQ-study-10, REQ-study-12)", () => {
	const good = { proposition: "A sigma algebra is closed under complement.", question: "Closed under what?", answer: "Complement." };
	it("sends ONLY the proposition through the pipeline, then links the node to the page and attaches an active user card", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(h.imports.length, 1);
		assert.match(h.imports[0]!.filePath, /^study\/a\/p0002-[0-9a-f]{8}\.md$/);
		assert.equal(h.imports[0]!.text, `${good.proposition}\n`);
		assert.deepEqual(h.links.events.map((e) => [e.nodeId, e.documentId, e.page]), [[r.nodeId, id, 2]]);
		assert.deepEqual(h.cards.created, [{ nodeId: r.nodeId, question: good.question, answer: good.answer }]);
		assert.deepEqual(h.cards.proposed, []);
	});
	it("pins the node by default and not when pin is false", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		const a = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		await h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: "Another one.", pin: false });
		assert.deepEqual(h.cards.pinned, [a.nodeId]);
	});
	it("attaches the card to the node closest to the proposition and links every node the import produced", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.pipeline.next = [
			{ id: "n_premise", name: "Premise", statement: "Complements exist.", aliases: [] },
			{ id: "n_main", name: "Main", statement: "A sigma algebra is closed under complement.", aliases: [] },
		];
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(r.nodeId, "n_main");
		assert.deepEqual(r.nodeIds, ["n_premise", "n_main"]);
		assert.deepEqual(h.links.events.map((e) => e.nodeId), ["n_premise", "n_main"]);
	});
	it("an equivalent existing node is linked, not duplicated (the pipeline returns the existing node)", async () => {
		const h = studyHarness({ existingNodes: [{ id: "n_old", name: "Old", statement: "Sigma algebras are closed under complements.", aliases: [] }] });
		const id = await registerA(h);
		h.pipeline.next = [{ id: "n_old", name: "Old", statement: "Sigma algebras are closed under complements.", aliases: [] }];
		const r = await h.svc.confirmCard({ documentId: id, page: 2, ...good });
		assert.equal(r.nodeId, "n_old");
	});
	it("writes nothing when the pipeline finds no proposition", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.pipeline.next = [];
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good }), 422, /found no proposition/);
		assert.deepEqual([h.links.events.length, h.cards.created.length, h.cards.pinned.length], [0, 0, 0]);
	});
	it("a pipeline failure is a 502 and writes nothing", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		h.fail.pipeline = true;
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good }), 502, /nothing was added: no model configured/);
		assert.deepEqual([h.links.events.length, h.cards.created.length, h.cards.pinned.length], [0, 0, 0]);
	});
	it("validates every field before any write", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: " " }), 400, /proposition is required/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, question: undefined }), 400, /question is required/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, answer: "x".repeat(2001) }), 400, /answer is too long/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 2, ...good, proposition: "x".repeat(401) }), 400, /proposition is too long/);
		await rejectsWith(h.svc.confirmCard({ documentId: id, page: 0, ...good }), 400, /page must be/);
		assert.equal(h.imports.length, 0);
	});
});

describe("a goal from a document (REQ-goal-01)", () => {
	it("creates a goal whose origin reference is the document", async () => {
		const h = studyHarness();
		const id = await registerA(h);
		assert.deepEqual(h.svc.startGoal({ documentId: id, title: " Master chapter 1 ", statement: "I can state the axioms of a sigma algebra." }), { goalId: "goal_1" });
		assert.deepEqual(h.goals, [{ title: "Master chapter 1", statement: "I can state the axioms of a sigma algebra.", originRef: id }]);
		assert.throws(() => h.svc.startGoal({ documentId: id, title: "", statement: "x" }), /title is required/);
	});
});