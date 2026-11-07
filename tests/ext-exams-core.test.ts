// tests/ext-exams-core.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_EXERCISE_CHARS } from "../src/core/ext/exams/bounds.ts";
import { chunkPages } from "../src/core/ext/exams/chunker.ts";
import { applyExerciseOp, ExerciseEditError, parseExerciseOp, type ExerciseOp } from "../src/core/ext/exams/exercises.ts";
import { bm25, selectWithinBudget, tokenize } from "../src/core/ext/exams/rank.ts";
import { DEFAULT_K, DEFAULT_MAX_TOKENS, MAX_K, MAX_SEARCH_TOKENS, searchChunks, searchOptions } from "../src/core/ext/exams/search.ts";
import { parseSplitResult, SplitRefused } from "../src/core/ext/exams/split.ts";
import { estimateTokens, truncateToTokens } from "../src/core/ext/exams/tokens.ts";
import type { Exercise } from "../src/core/ext/exams/types.ts";

const ex = (id: string, order: number, over: Partial<Exercise> = {}): Exercise => ({
	id,
	examId: "e1",
	order,
	pageStart: order,
	pageEnd: order,
	text: `Testo ${id}`,
	...over,
});

const ids = (list: Exercise[]) => list.map((e) => e.id);
const seq = () => {
	let n = 0;
	return () => `new${++n}`;
};

describe("exercise edits (REQ-ex-03)", () => {
	const list = [ex("a", 1), ex("b", 2), ex("c", 3)];

	it("merges an exercise with the next one, keeps the first id, widens the page span, renumbers", () => {
		const out = applyExerciseOp(list, { op: "merge", firstId: "a" }, seq());
		assert.deepEqual(ids(out), ["a", "c"]);
		assert.equal(out[0]!.text, "Testo a\n\nTesto b");
		assert.equal(out[0]!.pageStart, 1);
		assert.equal(out[0]!.pageEnd, 2);
		assert.deepEqual(out.map((e) => e.order), [1, 2]);
	});

	it("refuses to merge the last exercise, or an unknown id", () => {
		assert.throws(() => applyExerciseOp(list, { op: "merge", firstId: "c" }, seq()), ExerciseEditError);
		assert.throws(() => applyExerciseOp(list, { op: "merge", firstId: "zz" }, seq()), ExerciseEditError);
	});

	it("a merge or a split drops the solution and its origin; an edit keeps them", () => {
		const withSol = [ex("a", 1, { solution: "sol", origin: "exam" }), ex("b", 2)];
		const merged = applyExerciseOp(withSol, { op: "merge", firstId: "a" }, seq());
		assert.equal(merged[0]!.solution, undefined);
		assert.equal(merged[0]!.origin, undefined);
		const edited = applyExerciseOp(withSol, { op: "edit", id: "a", text: "Nuovo" }, seq());
		assert.equal(edited[0]!.solution, "sol");
		assert.equal(edited[0]!.origin, "exam");
	});

	it("splits at a character offset into two trimmed halves; the second half gets the new id", () => {
		const one = [ex("a", 1, { text: "Prima parte. Seconda parte." })];
		const out = applyExerciseOp(one, { op: "split", id: "a", at: 13 }, seq());
		assert.deepEqual(ids(out), ["a", "new1"]);
		assert.equal(out[0]!.text, "Prima parte.");
		assert.equal(out[1]!.text, "Seconda parte.");
		assert.deepEqual(out.map((e) => e.order), [1, 2]);
	});

	it("refuses a split that leaves an empty side or lies outside the text", () => {
		const one = [ex("a", 1, { text: "abc def" })];
		assert.throws(() => applyExerciseOp(one, { op: "split", id: "a", at: 0 }, seq()), ExerciseEditError);
		assert.throws(() => applyExerciseOp(one, { op: "split", id: "a", at: 7 }, seq()), ExerciseEditError);
		const spaced = [ex("a", 1, { text: "abc   " })];
		assert.throws(() => applyExerciseOp(spaced, { op: "split", id: "a", at: 4 }, seq()), /both sides/);
	});

	it("deletes and renumbers; edits text and refuses an empty or over-long text", () => {
		assert.deepEqual(ids(applyExerciseOp(list, { op: "delete", id: "b" }, seq())), ["a", "c"]);
		assert.equal(applyExerciseOp(list, { op: "edit", id: "b", text: "  Nuovo  " }, seq())[1]!.text, "Nuovo");
		assert.throws(() => applyExerciseOp(list, { op: "edit", id: "b", text: "   " }, seq()), ExerciseEditError);
		assert.throws(() => applyExerciseOp(list, { op: "edit", id: "b", text: "x".repeat(MAX_EXERCISE_CHARS + 1) }, seq()), ExerciseEditError);
	});

	it("does not change its input", () => {
		const before = JSON.stringify(list);
		applyExerciseOp(list, { op: "delete", id: "a" }, seq());
		assert.equal(JSON.stringify(list), before);
	});

	it("parses the op shape and refuses anything else with a fixed message", () => {
		assert.deepEqual(parseExerciseOp({ op: "split", id: "a", at: 3 }), { op: "split", id: "a", at: 3 });
		assert.throws(() => parseExerciseOp({ op: "split", id: "a", at: 3.5 }), ExerciseEditError);
		assert.throws(() => parseExerciseOp({ op: "drop", id: "a" }), /unknown edit/);
		assert.throws(() => parseExerciseOp({ op: "delete", id: "../etc" }), ExerciseEditError);
		assert.throws(() => parseExerciseOp([]), ExerciseEditError);
		const ok: ExerciseOp = parseExerciseOp({ op: "edit", id: "a", text: "t" });
		assert.equal(ok.op, "edit");
	});
});

describe("split validation (REQ-ex-02)", () => {
	const good = [
		{ pageStart: 2, pageEnd: 2, text: " Esercizio 2 " },
		{ pageStart: 1, pageEnd: 1, text: "Esercizio 1", solution: "Soluzione 1" },
	];

	it("orders by page, trims, and sets origin exam only when a solution came with it", () => {
		const out = parseSplitResult(good, 3);
		assert.deepEqual(out.map((e) => e.text), ["Esercizio 1", "Esercizio 2"]);
		assert.equal(out[0]!.origin, "exam");
		assert.equal(out[0]!.solution, "Soluzione 1");
		assert.equal(out[1]!.origin, undefined);
		assert.equal(out[1]!.solution, undefined);
	});

	it("refuses pages outside the exam, a reversed span, an empty text, an empty list", () => {
		assert.throws(() => parseSplitResult([{ pageStart: 1, pageEnd: 4, text: "x" }], 3), SplitRefused);
		assert.throws(() => parseSplitResult([{ pageStart: 2, pageEnd: 1, text: "x" }], 3), SplitRefused);
		assert.throws(() => parseSplitResult([{ pageStart: 1, pageEnd: 1, text: "  " }], 3), SplitRefused);
		assert.throws(() => parseSplitResult([], 3), SplitRefused);
		assert.throws(() => parseSplitResult("not a list", 3), SplitRefused);
	});
});

describe("chunker (REQ-ex-04)", () => {
	it("keeps each chunk on one page and numbers pages from 1; empty pages give nothing", () => {
		const out = chunkPages(["Primo paragrafo.\n\nSecondo.", "", "Terza pagina."]);
		assert.deepEqual(out.map((c) => c.page), [1, 3]);
		assert.equal(out[0]!.text, "Primo paragrafo.\n\nSecondo.");
	});

	it("packs paragraphs up to the size and cuts an over-long paragraph at a space", () => {
		const long = Array.from({ length: 40 }, (_, i) => `parola${i}`).join(" ");
		const out = chunkPages([long], 60);
		assert.ok(out.length > 1);
		for (const c of out) assert.ok(c.text.length <= 60, c.text);
		assert.equal(out.map((c) => c.text).join(" ").split(/\s+/).length, 40);
	});
});

describe("ranking (REQ-ex-05)", () => {
	it("normalises accents and case, and keeps letters and digits only", () => {
		assert.deepEqual(tokenize("Perché  è 3-Volte, VOLTE!"), ["perche", "e", "3", "volte", "volte"]);
	});

	it("ranks a chunk with the query terms first and leaves out chunks with none", () => {
		const items = [
			{ text: "il gatto dorme sul tetto" },
			{ text: "scheduling round robin con quanto di tempo" },
			{ text: "round robin e priorita" },
		];
		const out = bm25("round robin", items);
		assert.deepEqual(out.map((r) => r.item.text), ["round robin e priorita", "scheduling round robin con quanto di tempo"]);
	});

	it("an empty query or no items give no hits", () => {
		assert.deepEqual(bm25("   ", [{ text: "a" }]), []);
		assert.deepEqual(bm25("a", []), []);
	});

	it("respects the count and the token budget, cutting a hit that does not fit", () => {
		const items = [{ text: "uno ".repeat(10) }, { text: "uno ".repeat(200) }, { text: "uno due" }];
		const ranked = bm25("uno", items);
		const byCount = selectWithinBudget(ranked, 1, 10_000);
		assert.equal(byCount.length, 1);
		const budget = 60;
		const hits = selectWithinBudget(ranked, 10, budget);
		const spent = hits.reduce((n, h) => n + estimateTokens(h.text), 0);
		assert.ok(spent <= budget, `spent ${spent}`);
		assert.ok(hits.length >= 1);
	});
});

describe("token estimate and search options (REQ-ex-05)", () => {
	it("estimates by characters over three, rounded up, and cuts a text to a budget with a marker", () => {
		assert.equal(estimateTokens("abcdef"), 2);
		assert.equal(estimateTokens(""), 0);
		const cut = truncateToTokens("parola ".repeat(100), 10);
		assert.ok(estimateTokens(cut) <= 10);
		assert.ok(cut.endsWith("…"));
		assert.equal(truncateToTokens("ok", 0), "");
	});

	it("defaults K and the cap, and clamps both to the service maximum", () => {
		assert.deepEqual(searchOptions({}), { k: DEFAULT_K, maxTokens: DEFAULT_MAX_TOKENS });
		assert.deepEqual(searchOptions({ k: 999, maxTokens: 999_999 }), { k: MAX_K, maxTokens: MAX_SEARCH_TOKENS });
		assert.deepEqual(searchOptions({ k: -4, maxTokens: "lots" }), { k: 1, maxTokens: DEFAULT_MAX_TOKENS });
	});

	it("returns an empty array, never padding, when nothing matches or the query is blank", () => {
		const chunks = [{ materialId: "m1", title: "Dispensa", page: 3, text: "scheduling round robin" }];
		assert.deepEqual(searchChunks("   ", chunks, searchOptions()), []);
		assert.deepEqual(searchChunks("quantistica", chunks, searchOptions()), []);
		const hits = searchChunks("round robin", chunks, searchOptions());
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.page, 3);
		assert.equal(hits[0]!.materialId, "m1");
	});
});
