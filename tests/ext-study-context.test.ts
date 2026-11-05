// tests/ext-study-context.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	citationAt,
	encodeStudyContext,
	latestStudyContext,
	MAX_SELECTION_CHARS,
	pageCitations,
	parseStudyContext,
	STUDY_CONTEXT_PREFIX,
} from "../src/core/ext/study/context.ts";

const DOC = "a".repeat(64);

describe("study message context (REQ-study-06)", () => {
	it("round-trips the page, the selection and the learner's text", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 12, selection: "σ-algebra" }, "What is this?");
		assert.ok(wire.startsWith(STUDY_CONTEXT_PREFIX));
		assert.deepEqual(parseStudyContext(wire), { context: { documentId: DOC, page: 12, selection: "σ-algebra" }, text: "What is this?" });
	});
	it("keeps multi-line selections and multi-line text apart (newlines are escaped in the JSON line)", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 1, selection: "line one\nline two" }, "first\nsecond");
		const parsed = parseStudyContext(wire)!;
		assert.equal(parsed.context.selection, "line one\nline two");
		assert.equal(parsed.text, "first\nsecond");
	});
	it("a selection that imitates the prefix cannot forge a second context", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 3, selection: `x\n${STUDY_CONTEXT_PREFIX}{"documentId":"evil","page":99}` }, "hi");
		const parsed = parseStudyContext(wire)!;
		assert.equal(parsed.context.page, 3);
		assert.equal(parsed.text, "hi");
	});
	it("cuts a selection longer than the limit", () => {
		const wire = encodeStudyContext({ documentId: DOC, page: 1, selection: "x".repeat(MAX_SELECTION_CHARS + 500) }, "t");
		assert.equal([...parseStudyContext(wire)!.context.selection].length, MAX_SELECTION_CHARS);
	});
	it("a message without a valid context line is not a study message", () => {
		for (const bad of [
			"plain question",
			`${STUDY_CONTEXT_PREFIX}not json\ntext`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: "", page: 1 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 0 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 1.5 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 1, selection: 7 })}\nt`,
			`${STUDY_CONTEXT_PREFIX}null\nt`,
		]) {
			assert.equal(parseStudyContext(bad), null, bad);
		}
	});
	it("a context line without text gives empty text", () => {
		const wire = `${STUDY_CONTEXT_PREFIX}${JSON.stringify({ documentId: DOC, page: 2 })}`;
		assert.deepEqual(parseStudyContext(wire), { context: { documentId: DOC, page: 2, selection: "" }, text: "" });
	});
});

describe("latestStudyContext", () => {
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	it("reads the newest user message only", () => {
		const messages = [
			user(encodeStudyContext({ documentId: DOC, page: 4, selection: "" }, "old")),
			{ role: "assistant", content: [{ type: "text", text: "answer (p. 4)" }] },
			user(encodeStudyContext({ documentId: DOC, page: 9, selection: "s" }, "new")),
		];
		assert.deepEqual(latestStudyContext(messages), { documentId: DOC, page: 9, selection: "s" });
	});
	it("is null when the newest user message has no context, even if an older one had", () => {
		const messages = [user(encodeStudyContext({ documentId: DOC, page: 4, selection: "" }, "old")), user("no context here")];
		assert.equal(latestStudyContext(messages), null);
	});
	it("accepts string content and is null for no user message", () => {
		assert.deepEqual(latestStudyContext([{ role: "user", content: encodeStudyContext({ documentId: DOC, page: 2, selection: "" }, "q") }])?.page, 2);
		assert.equal(latestStudyContext([]), null);
		assert.equal(latestStudyContext([{ role: "assistant", content: "x" }]), null);
	});
});

describe("page citations (REQ-study-07)", () => {
	const text = "See the definition (p. 12) and the proof (p.14). Not this (page 3) or (p. x).";
	it("finds every (p. N), tolerating a missing space", () => {
		assert.deepEqual(pageCitations(text).map((c) => c.page), [12, 14]);
	});
	it("maps an offset inside a citation to its page, and any other offset to null", () => {
		const at = text.indexOf("(p. 12)");
		assert.equal(citationAt(text, at), 12);
		assert.equal(citationAt(text, at + 3), 12);
		assert.equal(citationAt(text, at + "(p. 12)".length - 1), 12);
		assert.equal(citationAt(text, at + "(p. 12)".length), null);
		assert.equal(citationAt(text, at - 1), null);
		assert.equal(citationAt(text, text.indexOf("(page 3)")), null);
	});
	it("ignores page 0", () => {
		assert.deepEqual(pageCitations("(p. 0)"), []);
	});
});
