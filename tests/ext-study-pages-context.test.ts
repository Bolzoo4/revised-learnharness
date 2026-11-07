// tests/ext-study-pages-context.test.ts
// The study message carries the other pages in view (`pages`), and the tutor's prompt names them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeStudyContext, extraPages, latestStudyContext, MAX_EXTRA_PAGES, parseStudyContext } from "../src/core/ext/study/context.ts";
import { studyPrompt } from "../src/agent/ext/study/study-instructions.ts";
import type { StudyToolContext } from "../src/agent/ext/study/study-tools.ts";

const DOC = { id: "doc1", title: "Analysis", pageCount: 10 };

/** A tool context whose chat holds one user message with the given text. */
function ctxWith(message: string | null): StudyToolContext {
	const messages = message === null ? [] : [{ role: "user", content: message }];
	return {
		chatId: "chat_1",
		chatStore: { getChat: () => ({ messages: messages as never }) },
		document: () => DOC,
		pageText: (p) => `text of page ${p}`,
		search: () => [],
	};
}

describe("the context line with pages in view", () => {
	it("a message without other pages is written exactly as before", () => {
		assert.equal(encodeStudyContext({ documentId: "d", page: 3, selection: "" }, "hi"), '[study-context] {"documentId":"d","page":3,"selection":""}\nhi');
		assert.equal(encodeStudyContext({ documentId: "d", page: 3, selection: "", pages: [] }, "hi"), '[study-context] {"documentId":"d","page":3,"selection":""}\nhi');
	});

	it("the other pages ride along, ascending, never the primary page", () => {
		const line = encodeStudyContext({ documentId: "d", page: 4, selection: "", pages: [5, 4, 3] }, "x").split("\n")[0]!;
		assert.deepEqual(JSON.parse(line.slice("[study-context] ".length)), { documentId: "d", page: 4, selection: "", pages: [3, 5] });
	});

	it("a message written before the field existed parses to the same context, with no pages key", () => {
		const parsed = parseStudyContext('[study-context] {"documentId":"d","page":2,"selection":"x"}\nhello');
		assert.deepEqual(parsed, { context: { documentId: "d", page: 2, selection: "x" }, text: "hello" });
		assert.ok(!("pages" in parsed!.context));
	});

	it("the round trip keeps the pages and the learner's text", () => {
		const out = encodeStudyContext({ documentId: "d", page: 7, selection: "a\nb", pages: [6, 8] }, "why?");
		const parsed = parseStudyContext(out);
		assert.deepEqual(parsed, { context: { documentId: "d", page: 7, selection: "a\nb", pages: [6, 8] }, text: "why?" });
	});

	it("garbage in the pages list is dropped, the message itself is kept", () => {
		const line = JSON.stringify({ documentId: "d", page: 5, selection: "", pages: ["3", -1, 0, 1.5, 5, 9, 9, 2, null, 4, 6] });
		const parsed = parseStudyContext(`[study-context] ${line}\nq`);
		assert.ok(parsed !== null, "message kept");
		assert.deepEqual(parsed!.context.pages, [2, 4], "only valid, distinct, non-primary pages, at most the cap");
		assert.equal(parsed!.text, "q");
	});

	it("a pages value that is not a list is no pages at all", () => {
		for (const pages of ["3", 3, { 0: 3 }, null]) {
			const parsed = parseStudyContext(`[study-context] ${JSON.stringify({ documentId: "d", page: 1, selection: "", pages })}\nq`);
			assert.ok(parsed !== null);
			assert.ok(!("pages" in parsed!.context), `pages ${JSON.stringify(pages)}`);
		}
	});

	it("at most MAX_EXTRA_PAGES other pages are kept, the lowest ones", () => {
		assert.equal(MAX_EXTRA_PAGES, 2);
		assert.deepEqual(extraPages(10, [1, 2, 3, 4]), [1, 2]);
		assert.deepEqual(extraPages(1, [1, 2, 3]), [2, 3]);
	});

	it("latestStudyContext reads the pages of the newest message only", () => {
		const older = encodeStudyContext({ documentId: "d", page: 1, selection: "", pages: [2] }, "a");
		const newer = encodeStudyContext({ documentId: "d", page: 5, selection: "" }, "b");
		assert.deepEqual(latestStudyContext([{ role: "user", content: older }, { role: "assistant", content: "ok" }, { role: "user", content: newer }]), {
			documentId: "d",
			page: 5,
			selection: "",
		});
	});
});

describe("the tutor's prompt with pages in view", () => {
	it("names the other visible pages without their text, and reads the primary page's text", () => {
		const msg = encodeStudyContext({ documentId: DOC.id, page: 4, selection: "", pages: [3, 5] }, "explain");
		const prompt = studyPrompt(ctxWith(msg));
		assert.ok(prompt.includes("The learner is on page 4. Its text:"));
		assert.ok(prompt.includes("text of page 4"));
		assert.ok(prompt.includes("The learner also sees part of pages 3, 5."), prompt);
		assert.ok(!prompt.includes("text of page 3"), "the other pages' text is not handed over: the tutor reads them with read_page");
		assert.ok(!prompt.includes("text of page 5"));
	});

	it("a single other page is named in the singular", () => {
		const msg = encodeStudyContext({ documentId: DOC.id, page: 4, selection: "", pages: [5] }, "explain");
		assert.ok(studyPrompt(ctxWith(msg)).includes("also sees part of page 5."));
	});

	it("a message without other pages gets no such line", () => {
		const msg = encodeStudyContext({ documentId: DOC.id, page: 4, selection: "" }, "explain");
		assert.ok(!studyPrompt(ctxWith(msg)).includes("also sees"));
	});

	it("other pages beyond the document's last page are not named", () => {
		const msg = `[study-context] ${JSON.stringify({ documentId: DOC.id, page: 9, selection: "", pages: [10, 11] })}\nq`;
		const prompt = studyPrompt(ctxWith(msg));
		assert.ok(prompt.includes("also sees part of page 10."), prompt);
		assert.ok(!prompt.includes("11"), "page 11 does not exist in a 10 page document");
	});

	it("with no context message the prompt names no pages", () => {
		const prompt = studyPrompt(ctxWith(null));
		assert.ok(!prompt.includes("also sees"));
		assert.ok(!prompt.includes("The learner is on page"));
	});
});
