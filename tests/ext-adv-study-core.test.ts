// tests/ext-adv-study-core.test.ts
// Adversarial tests for the pure core of assisted study. Written from the spec and the
// signature files only. "[spec-gap]" marks a test whose expectation is the safest reading
// of an ambiguous or silent spec, so it can be triaged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickCardNode, type CandidateNode } from "../src/core/ext/study/card-node.ts";
import {
	MAX_SELECTION_CHARS,
	STUDY_CONTEXT_PREFIX,
	citationAt,
	encodeStudyContext,
	latestStudyContext,
	pageCitations,
	parseStudyContext,
	userMessageText,
} from "../src/core/ext/study/context.ts";
import {
	DOCUMENT_ID_RE,
	deriveDocuments,
	documentOfChat,
	parseDocumentEvent,
	type DocumentEvent,
} from "../src/core/ext/study/documents.ts";
import {
	deriveDrafts,
	dropRepeats,
	parseDraftEvent,
	processedPages,
	sameProposition,
	type DraftEvent,
} from "../src/core/ext/study/drafts.ts";
import {
	linkedPages,
	nodeIdsOnPages,
	parseStudyLinkEvent,
	sourcesOfNode,
	type StudyLinkEvent,
} from "../src/core/ext/study/links.ts";
import {
	DEFAULT_DWELL_SECONDS,
	deriveReading,
	parseReadingEvent,
	type ReadingEvent,
} from "../src/core/ext/study/reading.ts";
import { slugOf, studySourcePath, studySourceText } from "../src/core/ext/study/source-path.ts";
import { isDocumentId } from "../src/core/ext/study/ports.ts";

// ---------- helpers ----------

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as object)) deepFreeze(v);
	}
	return value;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = fn();
	return { value, ms: performance.now() - start };
}

const node = (id: string, statement: string, name = id): CandidateNode => ({
	id,
	name,
	statement,
	aliases: [],
});

const words = (n: number, seed: number) =>
	Array.from({ length: n }, (_, k) => `w${(k * seed + 7) % 9973}`).join(" ");

const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;
const headingLines = (s: string) =>
	s.split(LINE_BREAK).filter((l) => /^\s{0,3}#{1,6}(\s|$)/.test(l)).length;
const fenceLines = (s: string) =>
	s.split(LINE_BREAK).filter((l) => /^\s{0,3}(`{3,}|~{3,})/.test(l)).length;

const prop = (
	draftId: string,
	proposition: string,
	page = 3,
	sec = 0,
	documentId = ID_A,
): DraftEvent => ({
	type: "proposed",
	draftId,
	documentId,
	page,
	proposition,
	question: "q",
	answer: "a",
	at: at(sec),
});

// ---------- REQ-study-09: which node a card attaches to ----------

describe("REQ-study-09 pickCardNode", () => {
	it("REQ-study-09 empty candidate list gives null", () => {
		assert.equal(pickCardNode("A is compact", []), null);
	});

	it("REQ-study-09 one-character token 'B' does not tie with 'A' even when listed first", () => {
		const nodes = [node("nB", "B is compact"), node("nA", "A is compact")];
		assert.equal(pickCardNode("A is compact", nodes), "nA");
		assert.equal(pickCardNode("A is compact", [...nodes].reverse()), "nA");
	});

	it("REQ-study-09 tie on Jaccard goes to the first node in the order given", () => {
		const x = node("first", "x");
		const y = node("second", "y");
		// proposition {x, y}: each candidate has Jaccard 1/2
		assert.equal(pickCardNode("x y", [x, y]), "first");
		assert.equal(pickCardNode("x y", [y, x]), "second");
	});

	it("REQ-study-09 identical names with different ids: the closest statement decides, not the name", () => {
		const nodes = [
			{ id: "n1", name: "Compactness", statement: "every open cover has a finite subcover", aliases: [] },
			{ id: "n2", name: "Compactness", statement: "A is compact", aliases: [] },
		];
		assert.equal(pickCardNode("A is compact", nodes), "n2");
	});

	it("REQ-study-09 non-Latin statements (Cyrillic, Greek) are compared by their words", () => {
		const ru = [node("dog", "собака лает на улице"), node("cat", "кошка сидит на окне")];
		assert.equal(pickCardNode("кошка сидит на окне", ru), "cat");
		const el = [node("other", "ο νόμος του Ohm"), node("energy", "η ενέργεια διατηρείται")];
		assert.equal(pickCardNode("η ενέργεια διατηρείται", el), "energy");
	});

	it("[spec-gap] REQ-study-09 a single candidate is returned even with zero word overlap", () => {
		assert.equal(pickCardNode("A is compact", [node("only", "zebras run fast")]), "only");
	});

	it("REQ-study-09 an empty statement neither wins nor poisons the comparison (NaN trap)", () => {
		assert.equal(pickCardNode("A is compact", [node("empty", ""), node("real", "A is compact")]), "real");
		assert.equal(pickCardNode("A is compact", [node("real", "A is compact"), node("empty", "")]), "real");
	});

	it("[spec-gap] REQ-study-09 an empty or blank proposition returns a candidate id or null, no throw", () => {
		const nodes = [node("a", "A is compact"), node("b", "B is stable")];
		for (const p of ["", "   "]) {
			const r = pickCardNode(p, nodes);
			assert.ok(r === null || r === "a" || r === "b", `got ${String(r)}`);
		}
	});

	it("[spec-gap] REQ-study-09 word overlap ignores case", () => {
		const nodes = [node("upper", "Mitochondria Produce ATP x y z"), node("lower", "mitochondria produce atp")];
		assert.equal(pickCardNode("Mitochondria produce ATP", nodes), "lower");
	});

	it("[spec-gap] REQ-study-09 Jaccard is over word sets, not word counts", () => {
		// sets: "set" = 1, "bag" = 2/3 -> set. counts would pick "bag".
		const nodes = [node("bag", "is compact other"), node("set", "is is is compact")];
		assert.equal(pickCardNode("is compact", nodes), "set");
	});

	it("REQ-study-09 pure: same input gives same id, and frozen inputs are not mutated", () => {
		const nodes = deepFreeze([node("a", "A is compact"), node("b", "A is stable")]);
		assert.equal(pickCardNode("A is compact", nodes), "a");
		assert.equal(pickCardNode("A is compact", nodes), "a");
	});

	it("REQ-study-09 500 candidates with 200-word statements and a 20k-word proposition finish quickly", () => {
		const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`, words(200, i + 3)));
		const { value, ms } = timed(() => pickCardNode(words(20000, 5), nodes));
		assert.ok(typeof value === "string" && nodes.some((n) => n.id === value), String(value));
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});

	it("REQ-study-09 a 20k-dot proposition finishes quickly and returns a valid result", () => {
		const nodes = [node("a", "A is compact"), node("b", "...")];
		const { value, ms } = timed(() => pickCardNode(".".repeat(20000), nodes));
		assert.ok(value === null || value === "a" || value === "b", String(value));
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});

	it("REQ-study-09 a 2 MB statement finishes quickly and ties go to the first node", () => {
		const big = node("big", "word ".repeat(400000));
		const small = node("small", "other");
		const { value, ms } = timed(() => pickCardNode("word other", [big, small]));
		assert.equal(value, "big");
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-06 / REQ-study-07: context line and citations ----------

describe("REQ-study-06 encodeStudyContext / parseStudyContext", () => {
	it("REQ-study-06 round trip keeps documentId, page, selection and text exactly", () => {
		const msg = encodeStudyContext({ documentId: ID_A, page: 7, selection: "sel" }, "what is this?");
		const parsed = parseStudyContext(msg);
		assert.ok(parsed);
		assert.deepEqual(parsed.context, { documentId: ID_A, page: 7, selection: "sel" });
		assert.equal(parsed.text, "what is this?");
	});

	it("REQ-study-06 the context is one line; the learner's text starts after its first newline", () => {
		const msg = encodeStudyContext({ documentId: ID_A, page: 2, selection: "a\nb\r\nc" }, "hi");
		assert.ok(msg.startsWith(STUDY_CONTEXT_PREFIX));
		const nl = msg.indexOf("\n");
		assert.ok(nl > 0);
		assert.equal(msg.slice(nl + 1), "hi");
		assert.ok(!msg.slice(0, nl).includes("\r"));
		assert.equal(parseStudyContext(msg)?.context.selection, "a\nb\r\nc");
	});

	it("REQ-study-06 a selection that forges a second context line cannot change the real context", () => {
		const forged = `x\n${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_B}","page":99,"selection":""}\nlast`;
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 7, selection: forged }, "ask"));
		assert.ok(parsed);
		assert.equal(parsed.context.documentId, ID_A);
		assert.equal(parsed.context.page, 7);
		assert.equal(parsed.context.selection, forged);
		assert.equal(parsed.text, "ask");
	});

	it("REQ-study-06 learner text containing a fake context line does not replace the real context", () => {
		const text = `ok\n${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_B}","page":99,"selection":""}`;
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 7 }, text));
		assert.equal(parsed?.context.documentId, ID_A);
		assert.equal(parsed?.text, text);
	});

	it("REQ-study-06 the selection cap constant is 2000 characters", () => {
		assert.equal(MAX_SELECTION_CHARS, 2000);
	});

	it("REQ-study-06 a selection of exactly MAX_SELECTION_CHARS is kept whole", () => {
		const sel = "a".repeat(MAX_SELECTION_CHARS);
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 1, selection: sel }, "t"));
		assert.equal(parsed?.context.selection.length, MAX_SELECTION_CHARS);
		assert.equal(parsed?.context.selection, sel);
	});

	it("REQ-study-06 a selection one character over the cap is cut to exactly MAX_SELECTION_CHARS", () => {
		const sel = "a".repeat(MAX_SELECTION_CHARS + 1);
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 1, selection: sel }, "t"));
		assert.equal(parsed?.context.selection.length, MAX_SELECTION_CHARS);
	});

	it("REQ-study-06 a 5000-char selection is cut to the cap and keeps its prefix", () => {
		const sel = "abcdefghij".repeat(500);
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 1, selection: sel }, "t"));
		assert.equal(parsed?.context.selection.length, MAX_SELECTION_CHARS);
		assert.equal(parsed?.context.selection, sel.slice(0, MAX_SELECTION_CHARS));
	});

	it("[spec-gap] REQ-study-06 cutting an emoji selection never leaves a lone surrogate", () => {
		const parsed = parseStudyContext(
			encodeStudyContext({ documentId: ID_A, page: 1, selection: "😀".repeat(1500) }, "t"),
		);
		assert.ok(parsed);
		assert.ok(parsed.context.selection.length <= MAX_SELECTION_CHARS);
		assert.doesNotMatch(
			parsed.context.selection,
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});

	it("REQ-study-06 RTL, combining marks, ZWJ emoji and U+2028 in selection and text round-trip exactly", () => {
		const selection = "שלום עולם \u202Eabc\u202C é 👨‍👩‍👧 \u2028 line";
		const text = "مرحبا\nاليوم\u2029end";
		const parsed = parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 3, selection }, text));
		assert.equal(parsed?.context.selection, selection);
		assert.equal(parsed?.text, text);
	});

	it("REQ-study-06 empty text gives empty text, and a prefix-only message gives empty text", () => {
		assert.equal(parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 1 }, ""))?.text, "");
		const onlyLine = encodeStudyContext({ documentId: ID_A, page: 1 }, "");
		assert.equal(parseStudyContext(onlyLine.replace(/\n$/, ""))?.text, "");
	});

	it("REQ-study-06 a missing selection is carried as the empty string", () => {
		assert.equal(parseStudyContext(encodeStudyContext({ documentId: ID_A, page: 1 }, "x"))?.context.selection, "");
	});
});

describe("REQ-study-06 parse tolerance", () => {
	it("REQ-study-06 a message without the prefix has no context", () => {
		assert.equal(parseStudyContext("hello there"), null);
		assert.equal(parseStudyContext(""), null);
	});

	it("REQ-study-06 the prefix is exact: no space after the tag is not a context line", () => {
		assert.equal(parseStudyContext(`[study-context]{"documentId":"${ID_A}","page":1,"selection":""}\nx`), null);
	});

	it("REQ-study-06 malformed JSON in the context line gives null, never a throw", () => {
		for (const bad of ["[study-context] {bad json\nhi", "[study-context] \nhi", `[study-context] {"documentId":"x"\nhi`]) {
			assert.equal(parseStudyContext(bad), null, JSON.stringify(bad));
		}
	});

	it("REQ-study-06 a context line that is not an object gives null", () => {
		for (const bad of ["null", "[]", "42", '"str"', "true"]) {
			assert.equal(parseStudyContext(`${STUDY_CONTEXT_PREFIX}${bad}\nhi`), null, bad);
		}
	});

	it("REQ-study-06 a page that is not a positive finite integer gives null", () => {
		const pages = ['"3"', "null", "true", "0", "-1", "1.5", "1e400"];
		for (const p of pages) {
			const line = `${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_A}","page":${p},"selection":""}\nhi`;
			assert.equal(parseStudyContext(line), null, `page ${p}`);
		}
	});

	it("REQ-study-06 a context without a string documentId, or without page, gives null", () => {
		assert.equal(parseStudyContext(`${STUDY_CONTEXT_PREFIX}{"page":1,"selection":""}\nhi`), null);
		assert.equal(parseStudyContext(`${STUDY_CONTEXT_PREFIX}{"documentId":42,"page":1,"selection":""}\nhi`), null);
		assert.equal(parseStudyContext(`${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_A}","selection":""}\nhi`), null);
	});

	it("[spec-gap] REQ-study-06 a non-string selection is either rejected or read as a string", () => {
		const r = parseStudyContext(`${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_A}","page":1,"selection":42}\nhi`);
		assert.ok(r === null || typeof r.context.selection === "string");
	});

	it("[spec-gap] REQ-study-06 extra keys in the context line do not invalidate it", () => {
		const r = parseStudyContext(`${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_A}","page":4,"selection":"","evil":true}\nhi`);
		assert.ok(r);
		assert.equal(r.context.page, 4);
		assert.equal(r.context.documentId, ID_A);
	});

	it("REQ-study-06 a __proto__ key in the context line neither throws nor pollutes Object.prototype", () => {
		const line = `${STUDY_CONTEXT_PREFIX}{"__proto__":{"polluted":true},"documentId":"${ID_A}","page":2,"selection":""}\nhi`;
		const r = parseStudyContext(line);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
		if (r) assert.equal(r.context.page, 2);
	});
});

describe("REQ-study-06 user message text and newest context", () => {
	it("REQ-study-06 userMessageText reads a string, and only the text parts of an array, in order", () => {
		assert.equal(userMessageText({ role: "user", content: "plain" }), "plain");
		const t = userMessageText({
			role: "user",
			content: [
				{ type: "text", text: "alpha" },
				{ type: "image", source: { data: "AAAA" } },
				{ type: "text", text: "beta" },
			],
		});
		assert.ok(t.indexOf("alpha") >= 0 && t.indexOf("beta") > t.indexOf("alpha"), t);
		assert.ok(!t.includes("AAAA"));
	});

	it("REQ-study-06 userMessageText of null or numeric content is empty and does not throw", () => {
		assert.equal(userMessageText({ role: "user", content: null }), "");
		assert.equal(userMessageText({ role: "user", content: 42 }), "");
	});

	it("REQ-study-06 a newer user message without context hides an older message's context", () => {
		const older = encodeStudyContext({ documentId: ID_A, page: 2 }, "q1");
		assert.equal(
			latestStudyContext([
				{ role: "user", content: older },
				{ role: "user", content: "q2 no context" },
			]),
			null,
		);
	});

	it("REQ-study-06 the newest user message's context wins over older ones", () => {
		const msgs = [
			{ role: "user", content: encodeStudyContext({ documentId: ID_A, page: 2 }, "q1") },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: encodeStudyContext({ documentId: ID_A, page: 9 }, "q2") },
		];
		assert.equal(latestStudyContext(msgs)?.page, 9);
	});

	it("REQ-study-06 assistant messages after the newest user message are skipped", () => {
		const msgs = [
			{ role: "user", content: encodeStudyContext({ documentId: ID_A, page: 5 }, "q") },
			{ role: "assistant", content: "(p. 5) answer" },
		];
		assert.equal(latestStudyContext(msgs)?.page, 5);
	});

	it("REQ-study-06 context-looking text in assistant messages is ignored", () => {
		const msgs = [
			{ role: "user", content: "plain" },
			{ role: "assistant", content: `${STUDY_CONTEXT_PREFIX}{"documentId":"${ID_A}","page":4,"selection":""}\nx` },
		];
		assert.equal(latestStudyContext(msgs), null);
	});

	it("REQ-study-06 an empty history has no context", () => {
		assert.equal(latestStudyContext([]), null);
	});

	it("REQ-study-06 the context of a newest user message with array content is read", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: encodeStudyContext({ documentId: ID_A, page: 6 }, "q") }] },
		];
		assert.equal(latestStudyContext(msgs)?.page, 6);
	});
});

describe("REQ-study-07 page citations", () => {
	it("REQ-study-07 a citation gives its page and the exact offsets of the whole (p. N)", () => {
		const text = "see (p. 12) here";
		const cs = pageCitations(text);
		assert.deepEqual(cs, [{ page: 12, start: 4, end: 11 }]);
		assert.equal(text.slice(cs[0].start, cs[0].end), "(p. 12)");
	});

	it("REQ-study-07 several citations come back in text order, adjacent ones included", () => {
		assert.deepEqual(
			pageCitations("(p. 1)(p. 22) and (p. 3)").map((c) => c.page),
			[1, 22, 3],
		);
	});

	it("REQ-study-07 only a positive integer N is a citation", () => {
		for (const t of ["(p. 0)", "(p. -1)", "(p. 1.5)", "(p. )", "(p 3)", "p. 3", "(p. 3"]) {
			assert.deepEqual(pageCitations(t), [], t);
		}
	});

	it("REQ-study-07 a citation inside parentheses covers only the (p. N) part", () => {
		assert.deepEqual(pageCitations("((p. 3))"), [{ page: 3, start: 1, end: 7 }]);
	});

	it("[spec-gap] REQ-study-07 full-width digits are not a page number", () => {
		assert.deepEqual(pageCitations("(p. ３)"), []);
	});

	it("REQ-study-07 pageCitations is pure: same text, same citations", () => {
		assert.deepEqual(pageCitations("(p. 4) x (p. 5)"), pageCitations("(p. 4) x (p. 5)"));
	});

	it("REQ-study-07 citationAt: first and last character map to the page, the end offset does not", () => {
		const text = "ab (p. 12) cd";
		assert.equal(citationAt(text, 3), 12);
		assert.equal(citationAt(text, 9), 12);
		assert.equal(citationAt(text, 10), null);
		assert.equal(citationAt(text, 2), null);
	});

	it("REQ-study-07 citationAt is null for negative, past-the-end and empty inputs", () => {
		assert.equal(citationAt("(p. 12)", -1), null);
		assert.equal(citationAt("(p. 12)", 999), null);
		assert.equal(citationAt("", 0), null);
	});

	it("REQ-study-07 a 1 MB text of unclosed '(p. ' openings finishes quickly (no backtracking blowup)", () => {
		const { value, ms } = timed(() => pageCitations("(p. ".repeat(200000) + "x"));
		assert.deepEqual(value, []);
		assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
	});

	it("REQ-study-07 150000 citations in a 1 MB text are all found, in order", () => {
		const { value, ms } = timed(() => pageCitations("(p. 1) ".repeat(150000)));
		assert.equal(value.length, 150000);
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-01 / REQ-study-05: documents ----------

describe("REQ-study-01 document identity", () => {
	it("REQ-study-01 DOCUMENT_ID_RE accepts a 64-char lowercase hex id on every call (no sticky lastIndex)", () => {
		assert.equal(DOCUMENT_ID_RE.test(ID_A), true);
		assert.equal(DOCUMENT_ID_RE.test(ID_A), true);
	});

	it("REQ-study-01 DOCUMENT_ID_RE rejects wrong lengths, path pieces, non-hex and surrounding whitespace", () => {
		const bad = [
			"a".repeat(63),
			"a".repeat(65),
			"../" + "a".repeat(61),
			ID_A + "\n",
			"\n" + ID_A,
			"g".repeat(64),
			" " + ID_A,
		];
		for (const b of bad) {
			DOCUMENT_ID_RE.lastIndex = 0;
			assert.equal(DOCUMENT_ID_RE.test(b), false, JSON.stringify(b));
		}
	});

	it("REQ-study-01 a registered event parses to the same fields", () => {
		const raw = { type: "registered", documentId: ID_A, title: "Anatomia", pageCount: 12, at: at(0) };
		assert.deepEqual(parseDocumentEvent(raw), raw);
	});

	it("REQ-study-05 a chat event parses to the same fields", () => {
		const raw = { type: "chat", documentId: ID_A, chatId: "c1", at: at(1) };
		assert.deepEqual(parseDocumentEvent(raw), raw);
	});

	it("REQ-study-01 wrong types, unknown types and missing fields make a document event null", () => {
		const base = { type: "registered", documentId: ID_A, title: "T", pageCount: 3, at: at(0) };
		const bad: unknown[] = [
			{ ...base, type: "deleted" },
			{ ...base, title: 42 },
			{ ...base, title: undefined },
			{ ...base, pageCount: "12" },
			{ ...base, pageCount: 1.5 },
			{ ...base, pageCount: NaN },
			{ ...base, pageCount: Infinity },
			{ ...base, documentId: 7 },
			{ type: "chat", documentId: ID_A, at: at(0) },
			null,
			"registered",
			42,
			[],
		];
		for (const raw of bad) assert.equal(parseDocumentEvent(raw), null, JSON.stringify(raw));
	});

	it("[spec-gap] REQ-study-01 a document needs at least one page and a sha256-shaped id", () => {
		const base = { type: "registered", documentId: ID_A, title: "T", pageCount: 3, at: at(0) };
		assert.equal(parseDocumentEvent({ ...base, pageCount: 0 }), null);
		assert.equal(parseDocumentEvent({ ...base, pageCount: -3 }), null);
		assert.equal(parseDocumentEvent({ ...base, documentId: "../etc/passwd" }), null);
	});

	it("REQ-study-01 a __proto__ key in an event neither throws nor pollutes", () => {
		const raw = JSON.parse(
			`{"type":"registered","__proto__":{"polluted":true},"documentId":"${ID_A}","title":"T","pageCount":3,"at":"${at(0)}"}`,
		);
		const r = parseDocumentEvent(raw);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
		if (r) assert.equal(r.documentId, ID_A);
	});
});

describe("REQ-study-01 / REQ-study-05 deriveDocuments", () => {
	const reg = (documentId: string, title: string, pageCount: number, sec: number): DocumentEvent => ({
		type: "registered",
		documentId,
		title,
		pageCount,
		at: at(sec),
	});
	const chat = (documentId: string, chatId: string, sec: number): DocumentEvent => ({
		type: "chat",
		documentId,
		chatId,
		at: at(sec),
	});

	it("REQ-study-01 the same file registered twice is one document: the first registration wins", () => {
		const docs = deriveDocuments([reg(ID_A, "First", 3, 0), reg(ID_A, "Second", 9, 5)]);
		assert.equal(docs.length, 1);
		assert.deepEqual(docs[0], { id: ID_A, title: "First", pageCount: 3, registeredAt: at(0), chatId: null });
	});

	it("REQ-study-01 identical titles with different ids are two documents", () => {
		const docs = deriveDocuments([reg(ID_A, "Notes", 2, 0), reg(ID_B, "Notes", 2, 1)]);
		assert.deepEqual(docs.map((d) => d.id).sort(), [ID_A, ID_B]);
	});

	it("REQ-study-01 non-Latin titles survive replay exactly", () => {
		const docs = deriveDocuments([reg(ID_A, "Κβαντική Φυσική", 2, 0), reg(ID_B, "量子力学 笔记", 2, 1)]);
		assert.deepEqual(docs.map((d) => d.title).sort(), ["Κβαντική Φυσική", "量子力学 笔记"].sort());
	});

	it("REQ-study-05 a chat event registered before its document is ignored (replay in file order)", () => {
		const docs = deriveDocuments([chat(ID_A, "c1", 0), reg(ID_A, "T", 3, 1)]);
		assert.equal(docs.length, 1);
		assert.equal(docs[0].chatId, null);
	});

	it("REQ-study-05 the first chat event wins, so a document has one conversation", () => {
		const docs = deriveDocuments([reg(ID_A, "T", 3, 0), chat(ID_A, "c1", 1), chat(ID_A, "c2", 2)]);
		assert.equal(docs[0].chatId, "c1");
	});

	it("REQ-study-05 a chat event for an unknown document creates no document", () => {
		assert.deepEqual(deriveDocuments([chat(ID_B, "c1", 0)]), []);
	});

	it("REQ-study-01 replaying every event twice gives the same documents (idempotent)", () => {
		const ev = [reg(ID_A, "T", 3, 0), chat(ID_A, "c1", 1), reg(ID_B, "U", 1, 2)];
		assert.deepEqual(deriveDocuments([...ev, ...ev]), deriveDocuments(ev));
	});

	it("REQ-study-01 pure over frozen input; empty input gives []", () => {
		const ev = deepFreeze([reg(ID_A, "T", 3, 0), chat(ID_A, "c1", 1)]);
		assert.deepEqual(deriveDocuments(ev), deriveDocuments(ev));
		assert.deepEqual(deriveDocuments([]), []);
	});
});

describe("REQ-study-05 documentOfChat", () => {
	const docs = [
		{ id: ID_A, title: "A", pageCount: 1, registeredAt: at(0), chatId: "c1" },
		{ id: ID_B, title: "B", pageCount: 1, registeredAt: at(0), chatId: null },
	];

	it("REQ-study-05 returns the document that owns the conversation", () => {
		assert.equal(documentOfChat(docs, "c1")?.id, ID_A);
	});

	it("REQ-study-05 an unknown chat id, and a document id used as a chat id, give null", () => {
		assert.equal(documentOfChat(docs, "nope"), null);
		assert.equal(documentOfChat(docs, ID_A), null);
	});

	it("REQ-study-05 a document without a conversation never matches: not for 'null' and not for ''", () => {
		assert.equal(documentOfChat(docs, "null"), null);
		assert.equal(documentOfChat(docs, ""), null);
	});
});

// ---------- REQ-study-11 / REQ-study-12: drafts ----------

describe("REQ-study-11 parseDraftEvent", () => {
	it("REQ-study-11 proposed, decided and pages_processed events parse to their fields", () => {
		const p = {
			type: "proposed",
			draftId: "d1",
			documentId: ID_A,
			page: 3,
			proposition: "Ο νόμος του Ohm ισχύει 👍",
			question: "q?",
			answer: "a",
			at: at(0),
		};
		const dec = { type: "decided", draftId: "d1", decision: "approved", at: at(1) };
		const pp = { type: "pages_processed", documentId: ID_A, pages: [1, 2], at: at(2) };
		assert.deepEqual(parseDraftEvent(p), p);
		assert.deepEqual(parseDraftEvent(dec), dec);
		assert.deepEqual(parseDraftEvent(pp), pp);
	});

	it("REQ-study-12 a decision other than approved or rejected is null", () => {
		for (const decision of ["pending", "approve", "", null]) {
			assert.equal(parseDraftEvent({ type: "decided", draftId: "d1", decision, at: at(0) }), null, String(decision));
		}
	});

	it("REQ-study-11 wrong types, unknown types and missing fields are null", () => {
		const base = {
			type: "proposed",
			draftId: "d1",
			documentId: ID_A,
			page: 3,
			proposition: "p",
			question: "q",
			answer: "a",
			at: at(0),
		};
		const bad: unknown[] = [
			{ ...base, page: "3" },
			{ ...base, page: 2.5 },
			{ ...base, page: undefined },
			{ ...base, proposition: 5 },
			{ ...base, draftId: undefined },
			{ ...base, type: "approved" },
			{ type: "pages_processed", documentId: ID_A, pages: [1, 2.5], at: at(0) },
			{ type: "pages_processed", documentId: ID_A, pages: ["3"], at: at(0) },
			{ type: "pages_processed", documentId: ID_A, pages: 3, at: at(0) },
			null,
			"proposed",
			9,
			[],
		];
		for (const raw of bad) assert.equal(parseDraftEvent(raw), null, JSON.stringify(raw));
	});

	it("[spec-gap] REQ-study-11 page numbers are 1-based: 0 and negatives are null", () => {
		const base = {
			type: "proposed",
			draftId: "d1",
			documentId: ID_A,
			page: 3,
			proposition: "p",
			question: "q",
			answer: "a",
			at: at(0),
		};
		assert.equal(parseDraftEvent({ ...base, page: 0 }), null);
		assert.equal(parseDraftEvent({ ...base, page: -1 }), null);
		assert.equal(parseDraftEvent({ type: "pages_processed", documentId: ID_A, pages: [0], at: at(0) }), null);
	});

	it("REQ-study-11 a __proto__ key in a draft event neither throws nor pollutes", () => {
		const raw = JSON.parse(
			`{"type":"decided","__proto__":{"polluted":true},"draftId":"d1","decision":"approved","at":"${at(0)}"}`,
		);
		const r = parseDraftEvent(raw);
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
		if (r) assert.equal(r.type, "decided");
	});
});

describe("REQ-study-11 / REQ-study-12 deriveDrafts and decisions", () => {
	const dec = (draftId: string, decision: "approved" | "rejected", sec = 1): DraftEvent => ({
		type: "decided",
		draftId,
		decision,
		at: at(sec),
	});

	it("REQ-study-11 the first proposed event per draft id defines the draft", () => {
		const drafts = deriveDrafts([prop("d1", "A is compact"), prop("d1", "B is compact", 9, 5)]);
		assert.equal(drafts.length, 1);
		assert.equal(drafts[0].id, "d1");
		assert.equal(drafts[0].proposition, "A is compact");
		assert.equal(drafts[0].page, 3);
		assert.equal(drafts[0].proposedAt, at(0));
	});

	it("REQ-study-12 the first decision wins: approved then rejected stays approved, and the reverse", () => {
		assert.equal(deriveDrafts([prop("d1", "x"), dec("d1", "approved"), dec("d1", "rejected")])[0].status, "approved");
		assert.equal(deriveDrafts([prop("d1", "x"), dec("d1", "rejected"), dec("d1", "approved")])[0].status, "rejected");
	});

	it("REQ-study-12 a decision before its proposal is ignored (replay in file order)", () => {
		const drafts = deriveDrafts([dec("d1", "approved", 0), prop("d1", "x", 3, 1)]);
		assert.equal(drafts[0].status, "pending");
	});

	it("REQ-study-11 a decision for an unknown draft creates nothing", () => {
		const drafts = deriveDrafts([dec("ghost", "approved"), prop("d1", "x")]);
		assert.deepEqual(drafts.map((d) => d.id), ["d1"]);
	});

	it("REQ-study-12 a proposal alone is pending, never active", () => {
		assert.equal(deriveDrafts([prop("d1", "x")])[0].status, "pending");
	});

	it("REQ-study-11 two draft ids with identical text stay two drafts in deriveDrafts", () => {
		assert.equal(deriveDrafts([prop("d1", "same"), prop("d2", "same")]).length, 2);
	});

	it("REQ-study-11 pages_processed events never create drafts", () => {
		assert.deepEqual(deriveDrafts([{ type: "pages_processed", documentId: ID_A, pages: [1], at: at(0) }]), []);
	});

	it("REQ-study-11 replaying events twice gives the same drafts (idempotent)", () => {
		const ev = [prop("d1", "x"), dec("d1", "approved"), prop("d2", "y", 4, 2)];
		assert.deepEqual(deriveDrafts([...ev, ...ev]), deriveDrafts(ev));
	});

	it("REQ-study-11 pure over frozen input; empty input gives []", () => {
		const ev = deepFreeze([prop("d1", "x"), dec("d1", "rejected")]);
		assert.deepEqual(deriveDrafts(ev), deriveDrafts(ev));
		assert.deepEqual(deriveDrafts([]), []);
	});
});

describe("REQ-study-11 processedPages", () => {
	const pp = (documentId: string, pages: number[]): DraftEvent => ({
		type: "pages_processed",
		documentId,
		pages,
		at: at(0),
	});

	it("REQ-study-11 processed pages are ascending and distinct across runs", () => {
		assert.deepEqual(processedPages([pp(ID_A, [3, 1, 3]), pp(ID_A, [2, 7])], ID_A), [1, 2, 3, 7]);
	});

	it("REQ-study-11 pages of other documents, and proposals, do not count", () => {
		assert.deepEqual(processedPages([pp(ID_A, [1]), pp(ID_B, [5])], ID_A), [1]);
		assert.deepEqual(processedPages([pp(ID_A, [1]), prop("d1", "x", 9, 1, ID_A)], ID_A), [1]);
		assert.deepEqual(processedPages([pp(ID_A, [1])], ID_B), []);
	});

	it("REQ-study-11 no events give no pages", () => {
		assert.deepEqual(processedPages([], ID_A), []);
	});
});

describe("REQ-study-11 sameProposition", () => {
	it("REQ-study-11 a final full stop is ignored when comparing", () => {
		assert.equal(sameProposition("A is compact.", "A is compact"), true);
		assert.equal(sameProposition("A is compact", "A is compact."), true);
	});

	it("REQ-study-11 a one-character token difference makes propositions different", () => {
		assert.equal(sameProposition("A is compact", "B is compact"), false);
		assert.equal(sameProposition("B is compact", "A is compact"), false);
		assert.equal(sameProposition("x = 1", "x = 2"), false);
	});

	it("[spec-gap] REQ-study-11 normalization folds case and whitespace", () => {
		assert.equal(sameProposition("A  is\tcompact ", "a is compact."), true);
	});

	it("[spec-gap] REQ-study-11 canonically equivalent Unicode is the same proposition", () => {
		assert.equal(sameProposition("café is good", "café is good"), true);
	});

	it("REQ-study-11 the comparison is symmetric", () => {
		const pairs: [string, string][] = [
			["A is compact.", "A is compact"],
			["A is compact", "B is compact"],
			["x", "x."],
		];
		for (const [a, b] of pairs) assert.equal(sameProposition(a, b), sameProposition(b, a), `${a} | ${b}`);
	});

	it("REQ-study-11 huge equal and different inputs finish quickly", () => {
		const eq = timed(() => sameProposition(".".repeat(20000), ".".repeat(20000)));
		assert.equal(eq.value, true);
		const big = "x".repeat(1000000);
		const diff = timed(() => sameProposition(big + "a", big + "b"));
		assert.equal(diff.value, false);
		assert.ok(eq.ms < 2000 && diff.ms < 2000, `took ${eq.ms.toFixed(0)} / ${diff.ms.toFixed(0)} ms`);
	});
});

describe("REQ-study-11 dropRepeats", () => {
	type C = { page: number; proposition: string };

	it("REQ-study-11 a candidate repeating an existing proposition is dropped (trailing stop ignored)", () => {
		assert.deepEqual(dropRepeats<C>([{ page: 1, proposition: "A is compact." }], ["A is compact"], 5), []);
	});

	it("REQ-study-11 a one-character difference from an existing proposition does not drop it", () => {
		const c: C[] = [{ page: 1, proposition: "B is compact" }];
		assert.deepEqual(dropRepeats(c, ["A is compact"], 5), c);
	});

	it("REQ-study-11 a repeat of an earlier candidate is dropped and the first one is kept", () => {
		const a = { page: 1, proposition: "X" };
		const out = dropRepeats<C>([a, { page: 1, proposition: "X." }, { page: 2, proposition: "Y" }], [], 5);
		assert.deepEqual(out, [a, { page: 2, proposition: "Y" }]);
	});

	it("REQ-study-11 perPage caps each page separately and keeps the order given", () => {
		const cs: C[] = [
			{ page: 1, proposition: "p1-1" },
			{ page: 1, proposition: "p1-2" },
			{ page: 1, proposition: "p1-3" },
			{ page: 2, proposition: "p2-1" },
			{ page: 2, proposition: "p2-2" },
			{ page: 2, proposition: "p2-3" },
		];
		assert.deepEqual(
			dropRepeats(cs, [], 2).map((c) => c.proposition),
			["p1-1", "p1-2", "p2-1", "p2-2"],
		);
	});

	it("REQ-study-11 perPage 0 keeps nothing; a very large perPage keeps every distinct candidate", () => {
		const cs: C[] = [
			{ page: 1, proposition: "a" },
			{ page: 1, proposition: "b" },
		];
		assert.deepEqual(dropRepeats(cs, [], 0), []);
		assert.equal(dropRepeats(cs, [], 1e9).length, 2);
	});

	it("[spec-gap] REQ-study-11 the same proposition on a later page is still a repeat", () => {
		const out = dropRepeats<C>(
			[
				{ page: 1, proposition: "Z is stable" },
				{ page: 2, proposition: "Z is stable" },
			],
			[],
			5,
		);
		assert.equal(out.length, 1);
		assert.equal(out[0].page, 1);
	});

	it("REQ-study-11 frozen inputs are not mutated and empty inputs give []", () => {
		const cs = deepFreeze<C[]>([{ page: 1, proposition: "a" }]);
		assert.equal(dropRepeats(cs, deepFreeze(["zzz"]), 5).length, 1);
		assert.deepEqual(dropRepeats<C>([], [], 5), []);
	});

	it("REQ-study-11 3000 candidates against 3000 existing propositions finish quickly", () => {
		const existing = Array.from({ length: 3000 }, (_, i) => `fact number ${i} is true`);
		const cands: C[] = Array.from({ length: 3000 }, (_, i) => ({
			page: 1 + (i % 50),
			proposition: `other ${i} holds`,
		}));
		const { value, ms } = timed(() => dropRepeats(cands, existing, 1000));
		assert.equal(value.length, 3000);
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-10: node <-> page links ----------

describe("REQ-study-10 study links", () => {
	const link = (nodeId: string, documentId: string, page: number, sec = 0): StudyLinkEvent => ({
		type: "link",
		nodeId,
		documentId,
		page,
		at: at(sec),
	});

	it("REQ-study-10 a link event parses to its fields; wrong type or incomplete events are null", () => {
		const ok = link("n1", ID_A, 4);
		assert.deepEqual(parseStudyLinkEvent(ok), ok);
		const bad: unknown[] = [
			{ ...ok, type: "unlink" },
			{ ...ok, nodeId: undefined },
			{ ...ok, documentId: 3 },
			{ ...ok, page: "4" },
			{ ...ok, page: 1.5 },
			{ ...ok, page: null },
			null,
			"link",
			[],
		];
		for (const raw of bad) assert.equal(parseStudyLinkEvent(raw), null, JSON.stringify(raw));
	});

	it("[spec-gap] REQ-study-10 page 0 and negative pages are null", () => {
		assert.equal(parseStudyLinkEvent({ ...link("n1", ID_A, 1), page: 0 }), null);
		assert.equal(parseStudyLinkEvent({ ...link("n1", ID_A, 1), page: -2 }), null);
	});

	it("REQ-study-10 sources of a node are distinct (document, page) pairs in first-appearance order", () => {
		const ev = [
			link("n1", ID_A, 5),
			link("n1", ID_A, 2),
			link("n1", ID_A, 5),
			link("n2", ID_A, 9),
			link("n1", ID_B, 5),
		];
		assert.deepEqual(sourcesOfNode(ev, "n1"), [
			{ documentId: ID_A, page: 5 },
			{ documentId: ID_A, page: 2 },
			{ documentId: ID_B, page: 5 },
		]);
	});

	it("REQ-study-10 an unknown node has no sources", () => {
		assert.deepEqual(sourcesOfNode([link("n1", ID_A, 1)], "nobody"), []);
	});

	it("[spec-gap] REQ-study-10 node ids are compared exactly, not case-folded", () => {
		assert.deepEqual(sourcesOfNode([link("N1", ID_A, 1)], "n1"), []);
	});

	it("REQ-study-10 linkedPages: distinct, ascending, and only the requested document", () => {
		const ev = [link("n1", ID_A, 5), link("n2", ID_A, 2), link("n3", ID_A, 5), link("n4", ID_B, 1)];
		assert.deepEqual(linkedPages(ev, ID_A), [2, 5]);
		assert.deepEqual(linkedPages(ev, ID_B), [1]);
		assert.deepEqual(linkedPages([], ID_A), []);
	});

	it("REQ-study-10 nodeIdsOnPages with no pages is empty even when the document has links", () => {
		assert.deepEqual(nodeIdsOnPages([link("n1", ID_A, 3)], ID_A, []), []);
	});

	it("REQ-study-10 nodeIdsOnPages matches the requested document and pages only", () => {
		const ev = [link("n1", ID_A, 3), link("n2", ID_B, 3), link("n3", ID_A, 4)];
		assert.deepEqual(nodeIdsOnPages(ev, ID_A, [3]).sort(), ["n1"]);
		assert.deepEqual(nodeIdsOnPages(ev, ID_A, [3, 4]).sort(), ["n1", "n3"]);
		assert.deepEqual(nodeIdsOnPages(ev, ID_A, [9]), []);
	});

	it("REQ-study-10 a node linked on several requested pages appears once", () => {
		const ev = [link("n1", ID_A, 3), link("n1", ID_A, 4), link("n1", ID_A, 4)];
		assert.deepEqual(nodeIdsOnPages(ev, ID_A, [3, 4, 3]), ["n1"]);
	});

	it("REQ-study-10 20000 links: node ids, linked pages and sources stay fast", () => {
		const ev = Array.from({ length: 20000 }, (_, i) => link(`n${i}`, ID_A, i + 1));
		const pages = Array.from({ length: 20000 }, (_, i) => i + 1);
		const ids = timed(() => nodeIdsOnPages(ev, ID_A, pages));
		assert.equal(ids.value.length, 20000);
		const lp = timed(() => linkedPages(ev, ID_A));
		assert.equal(lp.value.length, 20000);
		const hub = ev.map((e) => ({ ...e, nodeId: "hub" }));
		const src = timed(() => sourcesOfNode(hub, "hub"));
		assert.equal(src.value.length, 20000);
		assert.ok(ids.ms < 2000 && lp.ms < 2000 && src.ms < 2000, `took ${ids.ms.toFixed(0)}/${lp.ms.toFixed(0)}/${src.ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-03: reading state ----------

describe("REQ-study-03 reading", () => {
	const visit = (page: number, sec: number, documentId = ID_A): ReadingEvent => ({
		type: "visit",
		documentId,
		page,
		at: at(sec),
	});
	const close = (sec: number, documentId = ID_A): ReadingEvent => ({ type: "close", documentId, at: at(sec) });

	it("REQ-study-03 the default dwell is 5 seconds", () => {
		assert.equal(DEFAULT_DWELL_SECONDS, 5);
	});

	it("REQ-study-03 parse: visit and close parse; wrong fields or types are null", () => {
		const v = visit(2, 0);
		const c = close(1);
		assert.deepEqual(parseReadingEvent(v), v);
		assert.deepEqual(parseReadingEvent(c), c);
		const bad: unknown[] = [
			{ ...v, page: "2" },
			{ ...v, page: 2.5 },
			{ type: "visit", documentId: ID_A, at: at(0) },
			{ type: "seek", documentId: ID_A, page: 2, at: at(0) },
			{ type: "close", at: at(0) },
			null,
			[],
			7,
		];
		for (const raw of bad) assert.equal(parseReadingEvent(raw), null, JSON.stringify(raw));
	});

	it("[spec-gap] REQ-study-03 page 0 is not a readable page", () => {
		assert.equal(parseReadingEvent(visit(0, 0)), null);
	});

	it("REQ-study-03 a visit shorter than the dwell time does not count as read", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 4)], ID_A), { lastPage: 2, readPages: [] });
	});

	it("REQ-study-03 a visit of exactly the dwell time counts as read", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 5)], ID_A), { lastPage: 2, readPages: [1] });
	});

	it("REQ-study-03 the newest visit has no end yet: it is read only once another event follows", () => {
		assert.deepEqual(deriveReading([visit(3, 0)], ID_A), { lastPage: 3, readPages: [] });
		assert.deepEqual(deriveReading([visit(3, 0), close(10)], ID_A), { lastPage: 3, readPages: [3] });
	});

	it("REQ-study-03 a close event ends the visit: it lasts until the close", () => {
		assert.deepEqual(deriveReading([visit(1, 0), close(4)], ID_A).readPages, []);
		assert.deepEqual(deriveReading([visit(1, 0), close(5)], ID_A).readPages, [1]);
	});

	it("REQ-study-03 a close does not change the last page", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 10), close(20)], ID_A), {
			lastPage: 2,
			readPages: [1, 2],
		});
	});

	it("REQ-study-03 after a close, the next visit does not inherit the time before the close", () => {
		assert.deepEqual(deriveReading([visit(1, 0), close(2), visit(2, 100)], ID_A), {
			lastPage: 2,
			readPages: [],
		});
	});

	it("REQ-study-03 events of another document neither end a visit nor count as its pages", () => {
		const ev = [visit(1, 0, ID_A), visit(9, 1, ID_B), close(2, ID_B), visit(2, 10, ID_A)];
		assert.deepEqual(deriveReading(ev, ID_A), { lastPage: 2, readPages: [1] });
		assert.deepEqual(deriveReading(ev, ID_B), { lastPage: 9, readPages: [] });
	});

	it("REQ-study-03 revisits are not summed: no single visit reaches the dwell, so nothing is read", () => {
		// page 1 totals 5 s across two visits (3 s + 2 s); page 2 totals 4 s. No single visit reaches 5 s.
		const ev = [visit(1, 0), visit(2, 3), visit(1, 6), visit(2, 8), close(9)];
		assert.deepEqual(deriveReading(ev, ID_A), { lastPage: 2, readPages: [] });
	});

	it("REQ-study-03 readPages are ascending and distinct", () => {
		const ev = [visit(5, 0), visit(2, 10), visit(5, 20), close(30)];
		assert.deepEqual(deriveReading(ev, ID_A), { lastPage: 5, readPages: [2, 5] });
	});

	it("REQ-study-03 the dwellSeconds option changes the threshold; the default applies when omitted", () => {
		const ev = [visit(1, 0), visit(2, 3)];
		assert.deepEqual(deriveReading(ev, ID_A).readPages, []);
		assert.deepEqual(deriveReading(ev, ID_A, { dwellSeconds: 2 }).readPages, [1]);
	});

	it("REQ-study-03 with dwellSeconds 0, a zero-length visit counts as read", () => {
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 0)], ID_A, { dwellSeconds: 0 }).readPages, [1]);
	});

	it("REQ-study-03 the dwell test uses exact milliseconds (4.999 s is not read, 5.001 s is)", () => {
		const v = (page: number, iso: string): ReadingEvent => ({ type: "visit", documentId: ID_A, page, at: iso });
		const slow = [v(1, "2026-11-04T10:00:00.000Z"), v(2, "2026-11-04T10:00:04.999Z")];
		const fast = [v(1, "2026-11-04T10:00:00.000Z"), v(2, "2026-11-04T10:00:05.001Z")];
		assert.deepEqual(deriveReading(slow, ID_A).readPages, []);
		assert.deepEqual(deriveReading(fast, ID_A).readPages, [1]);
	});

	it("REQ-study-03 a visit that crosses midnight is measured in absolute time (23:59:58 to 00:00:03 is 5 s)", () => {
		const ev: ReadingEvent[] = [
			{ type: "visit", documentId: ID_A, page: 1, at: "2026-11-04T23:59:58.000Z" },
			{ type: "visit", documentId: ID_A, page: 2, at: "2026-11-05T00:00:03.000Z" },
		];
		assert.deepEqual(deriveReading(ev, ID_A).readPages, [1]);
	});

	it("REQ-study-03 timezone offsets are honoured: 01:00 at +01:00 is 00:00Z", () => {
		const ev: ReadingEvent[] = [
			{ type: "visit", documentId: ID_A, page: 1, at: "2026-11-05T01:00:00.000+01:00" },
			{ type: "visit", documentId: ID_A, page: 2, at: "2026-11-05T00:00:03.000Z" },
		];
		assert.deepEqual(deriveReading(ev, ID_A).readPages, []);
	});

	it("REQ-study-03 a visit spanning several days counts as read", () => {
		const ev: ReadingEvent[] = [
			{ type: "visit", documentId: ID_A, page: 1, at: "2026-11-04T10:00:00.000Z" },
			{ type: "visit", documentId: ID_A, page: 2, at: "2026-11-06T10:00:00.000Z" },
		];
		assert.deepEqual(deriveReading(ev, ID_A).readPages, [1]);
	});

	it("[spec-gap] REQ-study-03 an idle gap counts as dwell under the literal rule (no cap)", () => {
		// page 1 is open for an hour before the next event; the literal rule counts it as read.
		assert.deepEqual(deriveReading([visit(1, 0), visit(2, 3600), close(3601)], ID_A), {
			lastPage: 2,
			readPages: [1],
		});
	});

	it("[spec-gap] REQ-study-03 with pageCount, a page beyond the document is not read", () => {
		const ev = [visit(3, 0), visit(4, 10), close(20)];
		assert.deepEqual(deriveReading(ev, ID_A, { pageCount: 3 }).readPages, [3]);
	});

	it("[spec-gap] REQ-study-03 with pageCount, the page equal to pageCount is read and pageCount+1 is not", () => {
		assert.deepEqual(deriveReading([visit(4, 0), visit(5, 10), close(20)], ID_A, { pageCount: 4 }).readPages, [4]);
		assert.deepEqual(deriveReading([visit(5, 0), close(10)], ID_A, { pageCount: 4 }).readPages, []);
	});

	it("REQ-study-03 no visits give lastPage null and no read pages; closes or other documents do not open it", () => {
		assert.deepEqual(deriveReading([], ID_A), { lastPage: null, readPages: [] });
		assert.deepEqual(deriveReading([close(3)], ID_A), { lastPage: null, readPages: [] });
		assert.deepEqual(deriveReading([visit(2, 0, ID_B)], ID_A), { lastPage: null, readPages: [] });
	});

	it("REQ-study-03 deriveReading is pure over frozen input", () => {
		const ev = deepFreeze([visit(1, 0), visit(2, 6), close(7)]);
		assert.deepEqual(deriveReading(ev, ID_A), deriveReading(ev, ID_A));
	});

	it("REQ-study-03 50000 visits replay well inside the time bound", () => {
		const ev: ReadingEvent[] = [];
		for (let i = 0; i < 50000; i++) ev.push(visit((i % 7) + 1, i * 10));
		ev.push(close(50000 * 10));
		const { value, ms } = timed(() => deriveReading(ev, ID_A));
		assert.deepEqual(value.readPages, [1, 2, 3, 4, 5, 6, 7]);
		assert.equal(value.lastPage, (49999 % 7) + 1);
		assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-09 / REQ-study-12: source path and pipeline text ----------

describe("REQ-study-09 studySourcePath", () => {
	it("REQ-study-09 the same title, page and text give the same path", () => {
		assert.equal(studySourcePath("Book", 3, "A is compact"), studySourcePath("Book", 3, "A is compact"));
	});

	it("REQ-study-09 a different page, text or title gives a different path", () => {
		const base = studySourcePath("Book", 1, "A is compact");
		assert.notEqual(studySourcePath("Book", 2, "A is compact"), base);
		assert.notEqual(studySourcePath("Book", 11, "A is compact"), base);
		assert.notEqual(studySourcePath("Book", 1, "B is compact"), base);
		assert.notEqual(studySourcePath("Book", 1, "A is compact."), base);
		assert.notEqual(studySourcePath("Other", 1, "A is compact"), base);
	});

	it("REQ-study-09 no separator collision: title and page cannot run together into another page", () => {
		assert.notEqual(studySourcePath("ab1", 2, "x"), studySourcePath("ab", 12, "x"));
	});

	it("REQ-study-09 non-Latin titles that differ give different paths (not both reduced to an empty slug)", () => {
		assert.notEqual(studySourcePath("Νόμος", 1, "p"), studySourcePath("Κβαντικά", 1, "p"));
		assert.notEqual(studySourcePath("量子力学", 1, "p"), studySourcePath("物理", 1, "p"));
	});

	it("[spec-gap] REQ-study-09 titles differing only by case or punctuation give different paths", () => {
		assert.notEqual(studySourcePath("Notes: Ch.1", 1, "p"), studySourcePath("Notes Ch 1", 1, "p"));
		assert.notEqual(studySourcePath("Notes", 1, "p"), studySourcePath("notes", 1, "p"));
	});

	it("REQ-study-09 a proposition with line breaks gives a single-line path", () => {
		assert.ok(!/[\r\n]/.test(studySourcePath("T", 1, "A\r\n# Heading\n")));
	});

	it("REQ-study-09 the path never contains NUL or a line break, whatever the title", () => {
		for (const title of ["x\0y", "line\nbreak\r", "a\u2028b"]) {
			const p = studySourcePath(title, 1, "A\n# Heading\n\0");
			assert.doesNotMatch(p, /[\0\r\n]/, JSON.stringify(title));
		}
	});

	it("[spec-gap] REQ-study-09 a hostile title cannot add path segments such as '.' or '..'", () => {
		// The path has its own directory layout; only the title-derived part must stay inside one segment.
		for (const title of ["../../etc/passwd", "a/b\\c", "..\\..\\win"]) {
			const p = studySourcePath(title, 1, "A is compact");
			const segments = p.split("/");
			assert.ok(segments.every((s) => s !== "" && s !== "." && s !== ".."), `${p} for ${JSON.stringify(title)}`);
		}
	});

	it("[spec-gap] REQ-study-09 slugOf keeps titles path-safe: no separators, NUL or line breaks", () => {
		for (const t of ["../../etc/passwd", "a/b\\c", "x\0y", "line\nbreak\r"]) {
			assert.doesNotMatch(slugOf(t), /[\/\\\0\r\n]/, JSON.stringify(t));
		}
	});

	it("REQ-study-09 slugOf of an empty title returns a string and does not throw", () => {
		assert.equal(typeof slugOf(""), "string");
	});

	it("REQ-study-09 a 1 MB title and a 1 MB proposition finish quickly", () => {
		const big = "word ".repeat(200000);
		const { value, ms } = timed(() => studySourcePath(big, 1, big));
		assert.equal(typeof value, "string");
		assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
	});
});

describe("REQ-study-09 studySourceText (untrusted text handed to the pipeline)", () => {
	it("REQ-study-09 the text handed to the pipeline is the proposition alone", () => {
		assert.equal(studySourceText("A is compact").trim(), "A is compact");
	});

	it("[spec-gap] untrusted text: a proposition with line breaks cannot start a markdown heading", () => {
		assert.equal(headingLines(studySourceText("A is compact\n# Injected\n## Also injected")), 0);
	});

	it("[spec-gap] untrusted text: a bare carriage return cannot start a markdown heading", () => {
		assert.equal(headingLines(studySourceText("A is compact\r# Injected")), 0);
	});

	it("[spec-gap] untrusted text: a proposition cannot open a fenced code block", () => {
		assert.equal(fenceLines(studySourceText("A\n```\nrm -rf /\n```")), 0);
	});

	it("REQ-study-12 empty or blank input gives a string without throwing", () => {
		assert.equal(typeof studySourceText(""), "string");
		assert.equal(typeof studySourceText("   \n  "), "string");
	});

	it("REQ-study-09 a 1 MB proposition finishes quickly and is deterministic", () => {
		const big = "frase uno. ".repeat(90000);
		const a = timed(() => studySourceText(big));
		assert.equal(a.value, studySourceText(big));
		assert.ok(a.ms < 2000, `took ${a.ms.toFixed(0)} ms`);
	});
});

// ---------- REQ-study-01 / ports: id guard ----------

describe("REQ-study-01 isDocumentId (ports)", () => {
	it("REQ-study-01 accepts a sha256-shaped lowercase id", () => {
		assert.equal(isDocumentId(ID_A), true);
		assert.equal(isDocumentId("0123456789abcdef".repeat(4)), true);
	});

	it("REQ-study-01 rejects empty, path-like, wrong-length and non-string values without throwing", () => {
		const bad: unknown[] = [
			"",
			"..",
			"../" + "a".repeat(61),
			ID_A + "x",
			"a".repeat(63),
			"a".repeat(65),
			undefined,
			null,
			42,
			{},
			[ID_A],
		];
		for (const v of bad) {
			const label = `type=${typeof v} length=${typeof v === "string" ? v.length : "n/a"} value=${JSON.stringify(v)}`;
			assert.equal(isDocumentId(v as string), false, label);
		}
	});

	it("REQ-study-01 isDocumentId agrees with DOCUMENT_ID_RE", () => {
		for (const s of [ID_A, "x", "", "a".repeat(63), "A".repeat(64), "../" + "a".repeat(61)]) {
			DOCUMENT_ID_RE.lastIndex = 0;
			assert.equal(isDocumentId(s), DOCUMENT_ID_RE.test(s), JSON.stringify(s));
		}
	});
});

// ---------- REQ-src-05: quote check (quote.d.ts) ----------
// The module path is not in the signature files. It is loaded lazily inside each test,
// so a wrong path fails only these tests and not the rest of the file.

type QuoteModule = typeof import("../src/core/ext/quote.ts");
const loadQuote = () => import("../src/core/ext/quote.ts") as Promise<QuoteModule>;

describe("REQ-src-05 quote check", () => {
	it("REQ-src-05 MIN_QUOTE_CHARS is 20 and the boundary is exact", async () => {
		const { checkQuote, MIN_QUOTE_CHARS } = await loadQuote();
		assert.equal(MIN_QUOTE_CHARS, 20);
		const s19 = "abcdefghijklmnopqrs";
		const s20 = s19 + "t";
		const snapshot = `intro ${s20} outro text here`;
		assert.equal(checkQuote(snapshot, s19), "quote_too_short");
		assert.equal(checkQuote(snapshot, s20), "ok");
	});

	it("REQ-src-05 length is counted after normalization: padding whitespace does not make a quote long", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("snapshot a b c something long here", "a" + " ".repeat(100) + "b"), "quote_too_short");
	});

	it("REQ-src-05 a verbatim quote in the snapshot is ok", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("The quick brown fox jumps over the lazy dog.", "quick brown fox jumps over"), "ok");
	});

	it("REQ-src-05 a quote with one letter changed is not found (no fuzzy matching)", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("The quick brown fox jumps over the lazy dog.", "quick brown fix jumps over"), "quote_not_found");
		assert.equal(checkQuote("Proposition: B is compact and stable.", "A is compact and stable."), "quote_not_found");
	});

	it("REQ-src-05 whitespace, tabs and line breaks are normalized on both sides", async () => {
		const { checkQuote } = await loadQuote();
		const snap = "quick  brown\n\tfox jumps   over the lazy";
		assert.equal(checkQuote(snap, "quick brown fox jumps over"), "ok");
		assert.equal(checkQuote(snap, "quick brown\nfox jumps over"), "ok");
	});

	it("REQ-src-05 case is normalized", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("THE QUICK BROWN FOX JUMPS", "the quick brown fox jumps"), "ok");
	});

	it("REQ-src-05 a word hyphenated at a line break matches in the joined reading", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("the inter-\nnational community agreed to it", "international community agreed to it"), "ok");
	});

	it("REQ-src-05 a word hyphenated at a line break also matches in the kept-hyphen reading", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("a well-\nknown method for this", "well-known method for this"), "ok");
	});

	it("REQ-src-05 a line-break hyphen is not a space: 'well known' does not match 'well-' + newline + 'known'", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("a well-\nknown method for this", "well known method for this"), "quote_not_found");
	});

	it("REQ-src-05 soft hyphen is removed before matching", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("inter­national community agreed to it", "international community agreed to it"), "ok");
	});

	it("REQ-src-05 typographic quotes and dashes fold to their ASCII forms", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(
			checkQuote("he said “quoted text is here” and 2000–2010 passed by", 'he said "quoted text is here" and 2000-2010 passed'),
			"ok",
		);
	});

	it("REQ-src-05 NFKC: full-width letters match ASCII", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("The ＡＢＣ theorem states that", "The ABC theorem states that"), "ok");
	});

	it("REQ-src-05 canonically equivalent accents match (precomposed vs combining)", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("café au lait is served daily", "café au lait is served daily"), "ok");
	});

	it("REQ-src-05 Greek, Cyrillic and Arabic quotes match, with case folding for the cased scripts", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(
			checkQuote("Η ενέργεια του συστήματος διατηρείται πάντα", "Η ενέργεια του συστήματος διατηρείται πάντα"),
			"ok",
		);
		assert.equal(
			checkQuote("ПРИРОДА ЧИСЕЛ ВАЖНА ДЛЯ НАС ВСЕХ", "природа чисел важна для нас всех"),
			"ok",
		);
		assert.equal(checkQuote("مرحبا بكم في هذا الكتاب الجميل جدا", "مرحبا بكم في هذا الكتاب الجميل جدا"), "ok");
	});

	it("REQ-src-05 an emoji inside a quote matches", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("I love this 😀 so much today", "I love this 😀 so much"), "ok");
	});

	it("REQ-src-05 a quote that is a substring of a longer word still occurs verbatim", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("unbelievably quick brown fox jumps", "believably quick brown fox jumps"), "ok");
	});

	it("REQ-src-05 a non-breaking space counts as whitespace", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("quick brown fox jumps over the lazy dog", "quick brown fox jumps over the lazy dog"), "ok");
	});

	it("[spec-gap] REQ-src-05 zero-width space is not in the listed normalization, so it is not removed", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("quick brown\u200Bfox jumps over the lazy", "quick brownfox jumps over the lazy"), "quote_not_found");
	});

	it("REQ-src-05 empty, blank and longer-than-snapshot inputs give the right verdicts", async () => {
		const { checkQuote } = await loadQuote();
		assert.equal(checkQuote("", "a long enough quote text here"), "quote_not_found");
		assert.equal(checkQuote("snapshot content here long", ""), "quote_too_short");
		assert.equal(checkQuote("snapshot content here long", "   \n\t  "), "quote_too_short");
		assert.equal(checkQuote("short", "a quote much longer than the snapshot itself"), "quote_not_found");
	});

	it("REQ-src-05 normalizeForMatch lowercases, folds NFKC and removes soft hyphens", async () => {
		const { normalizeForMatch } = await loadQuote();
		const out = normalizeForMatch("ＡＢＣ­ DEF", "join");
		assert.ok(out.includes("abc def"), out);
		assert.equal(out, out.toLowerCase());
		assert.ok(!out.includes("­"));
	});

	it("REQ-src-05 normalizeForMatch: join drops the hyphen at a line break, keep keeps it", async () => {
		const { normalizeForMatch } = await loadQuote();
		assert.ok(normalizeForMatch("inter-\nnational", "join").includes("international"));
		assert.ok(normalizeForMatch("inter-\nnational", "keep").includes("inter-national"));
	});

	it("REQ-src-05 checkQuote and normalizeForMatch are pure: same input, same output", async () => {
		const { checkQuote, normalizeForMatch } = await loadQuote();
		const snap = "the inter-\nnational community agreed to it";
		assert.equal(checkQuote(snap, "international community agreed to it"), checkQuote(snap, "international community agreed to it"));
		assert.equal(normalizeForMatch(snap, "keep"), normalizeForMatch(snap, "keep"));
	});

	it("REQ-src-05 a 2 MB snapshot with an absent quote finishes quickly", async () => {
		const { checkQuote } = await loadQuote();
		const { value, ms } = timed(() => checkQuote("lorem ipsum dolor ".repeat(120000), "zzzz not in the text at all"));
		assert.equal(value, "quote_not_found");
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});

	it("REQ-src-05 a 1 MB snapshot full of line-break hyphens finishes quickly", async () => {
		const { checkQuote } = await loadQuote();
		const { value, ms } = timed(() => checkQuote("inter-\nnational ".repeat(70000), "x".repeat(30)));
		assert.equal(value, "quote_not_found");
		assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
	});

	it("REQ-src-05 a 20000-dot quote is found only when present, and quickly", async () => {
		const { checkQuote } = await loadQuote();
		const full = timed(() => checkQuote(".".repeat(20000), ".".repeat(20000)));
		assert.equal(full.value, "ok");
		const short = timed(() => checkQuote(".".repeat(19999), ".".repeat(20000)));
		assert.equal(short.value, "quote_not_found");
		assert.ok(full.ms < 3000 && short.ms < 3000, `took ${full.ms.toFixed(0)} / ${short.ms.toFixed(0)} ms`);
	});
});
