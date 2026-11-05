// tests/ext-study-tools.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStudyAgent } from "../src/agent/ext/study/study-agent.ts";
import { STUDY_INSTRUCTIONS, studyPrompt } from "../src/agent/ext/study/study-instructions.ts";
import { formatPage, MAX_PAGE_CHARS, MAX_SEARCH_HITS, studyTools, type StudyToolContext } from "../src/agent/ext/study/study-tools.ts";
import { encodeStudyContext } from "../src/core/ext/study/context.ts";
import { newUserMessage, type LhMessage } from "../src/core/native-messages.ts";

const DOC = "d".repeat(64);
const PAGES = ["Cover.", "A sigma algebra is a family closed under complement.", "", "Proofs by induction."];

function ctxFor(messages: LhMessage[], over: Partial<StudyToolContext> = {}): StudyToolContext {
	return {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages }) },
		document: () => ({ id: DOC, title: "Probability", pageCount: PAGES.length }),
		pageText: (p) => PAGES[p - 1] ?? null,
		search: (q) => PAGES.flatMap((t, i) => (t.toLowerCase().includes(q.toLowerCase()) ? [{ page: i + 1, snippet: t.slice(0, 40) }] : [])),
		...over,
	};
}
const text = (r: unknown): string => JSON.stringify(r);

describe("read_page and search_pages (REQ-study-07)", () => {
	it("registers exactly the two read-only tools", () => {
		assert.deepEqual(Object.keys(studyTools(ctxFor([]))).sort(), ["read_page", "search_pages"]);
	});
	it("read_page returns the page under a header that names the page and the page count", async () => {
		const out = await studyTools(ctxFor([])).read_page!.execute("t", { page: 2 } as never);
		assert.match(text(out), /Probability, page 2 of 4 ---\\nA sigma algebra is a family/);
	});
	it("read_page says so for a page without text, and refuses a page beyond the end", async () => {
		const tools = studyTools(ctxFor([]));
		assert.match(text(await tools.read_page!.execute("t", { page: 3 } as never)), /no extractable text/);
		assert.match(text(await tools.read_page!.execute("t", { page: 9 } as never)), /beyond the last page \(4\)/);
	});
	it("read_page truncates a very long page", () => {
		const out = formatPage("T", 1, 1, "x".repeat(MAX_PAGE_CHARS + 50));
		assert.match(out, /\[page truncated\]$/);
	});
	it("search_pages cites hits as (p. N), caps them, and reports no match", async () => {
		const tools = studyTools(ctxFor([]));
		assert.match(text(await tools.search_pages!.execute("t", { query: "SIGMA" } as never)), /\(p\. 2\) A sigma algebra/);
		assert.match(text(await tools.search_pages!.execute("t", { query: "zebra" } as never)), /No page contains .*zebra/);
		const many = studyTools(ctxFor([], { search: () => Array.from({ length: 30 }, (_, i) => ({ page: i + 1, snippet: "s" })) }));
		const out = (await many.search_pages!.execute("t", { query: "ab" } as never)) as { details: string };
		assert.equal(out.details.split("\n").length, MAX_SEARCH_HITS);
	});
	it("says so when the document is gone", async () => {
		const tools = studyTools(ctxFor([], { document: () => null }));
		assert.match(text(await tools.read_page!.execute("t", { page: 1 } as never)), /not available/);
	});
});

describe("the per-turn prompt (REQ-study-06)", () => {
	const message = (page: number, selection: string) => newUserMessage(encodeStudyContext({ documentId: DOC, page, selection }, "What is this?"));
	it("includes the text of the page named by the newest message and the selection", () => {
		const prompt = studyPrompt(ctxFor([message(2, "closed under complement")]));
		assert.ok(prompt.startsWith(STUDY_INSTRUCTIONS));
		assert.match(prompt, /on page 2\. Its text:\n<<<PAGE\nA sigma algebra is a family closed under complement\.\nPAGE>>>/);
		assert.match(prompt, /<<<SELECTION\nclosed under complement\nSELECTION>>>/);
	});
	it("uses the newest message's page, not an older one", () => {
		const prompt = studyPrompt(ctxFor([message(2, ""), message(4, "")]));
		assert.match(prompt, /on page 4/);
		assert.doesNotMatch(prompt, /SELECTION/);
	});
	it("gives only the fixed rules when the message has no context or names another document or a missing page", () => {
		assert.doesNotMatch(studyPrompt(ctxFor([newUserMessage("plain")])), /The learner is on page/);
		const other = newUserMessage(encodeStudyContext({ documentId: "e".repeat(64), page: 2, selection: "" }, "q"));
		assert.doesNotMatch(studyPrompt(ctxFor([other])), /The learner is on page/);
		assert.doesNotMatch(studyPrompt(ctxFor([message(40, "")])), /The learner is on page/);
	});
	it("marks a page without text", () => {
		assert.match(studyPrompt(ctxFor([message(3, "")])), /\(no extractable text on this page\)/);
	});
	it("tells the model when the document is unavailable", () => {
		assert.match(studyPrompt(ctxFor([], { document: () => null })), /document is not available/);
	});
	it("the instructions ask for (p. N) citations and forbid making cards", () => {
		assert.match(STUDY_INSTRUCTIONS, /\(p\. N\)/);
		assert.match(STUDY_INSTRUCTIONS, /do not create cards/i);
	});
	it("builds an agent", () => {
		const agent = createStudyAgent(ctxFor([]), {
			engine: { model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never, streamFn: (async () => { throw new Error("not streamed"); }) as never },
		});
		assert.equal(typeof agent.prompt, "function");
	});
});
