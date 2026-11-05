import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { buildLecture } from "../src/core/ext/lecture/build.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { chapterSourcePath, runChapter, type ChapterProgress, type ChapterRunDeps } from "../src/agent/ext/lecture/chapter-run.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

const book = { bookId: "b0123abcd", bookTitle: "Probability 1" };
const chapter = { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 };
const SRC = "src_0123456789ab";

const node = (id: string): Pick<GraphNode, "id" | "name" | "statement" | "provenance"> => ({ id, name: id, statement: `statement of ${id}`, provenance: [{ chatId: SRC, messageId: "" }] });
const base = makeLecture();
const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };

function harness(over: Partial<ChapterRunDeps> = {}) {
	const store = new Map<string, Lecture>();
	const calls = { imports: 0, outlines: 0, writes: [] as (string | null)[], prevSummaries: [] as (string | null)[] };
	let imported = false;
	const progress: ChapterProgress[] = [];
	const gate: CostGate = { allowed: () => true, record: () => {} };
	const deps: ChapterRunDeps = {
		gate,
		lectures: {
			save: (l) => void store.set(l.id, l),
			list: () => [...store.values()],
			remove: (id) => void store.delete(id),
		},
		importChapterGraph: async () => { calls.imports++; imported = true; },
		findSourceId: () => (imported ? SRC : null),
		readNodes: () => (imported ? [node(NODE_A), node(NODE_B)] : []),
		readChapterText: async () => "Unrelated chapter source text that is never copied by the lecture.",
		writeOutline: async () => { calls.outlines++; return [{ title: "T", kind: "definition", summary: "s" }]; },
		writeLecture: async (input) => { calls.writes.push(input.feedback); calls.prevSummaries.push(input.previousSummary); return draft; },
		now: () => "2026-11-04T10:00:00.000Z",
		onProgress: (p) => void progress.push(p),
		...over,
	};
	return { deps, store, calls, progress };
}

describe("runChapter", () => {
	it("extracts the graph from the chapter text first, then writes and saves the lecture", async () => {
		const h = harness();
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.deepEqual(r.lectureIds, ["lec_b0123abcd_c02_l01"]);
		assert.equal(h.calls.imports, 1);
		assert.equal(h.store.get("lec_b0123abcd_c02_l01")?.chapterSourceId, SRC);
		assert.deepEqual(r.uncoveredNodeIds, []);
		assert.deepEqual(h.progress.map((p) => p.state).slice(0, 4), ["queued", "graph", "outline", "writing"]);
	});
	it("does not re-import a chapter whose graph already exists", async () => {
		let imports = 0;
		const h = harness({ findSourceId: () => SRC, readNodes: () => [node(NODE_A), node(NODE_B)], importChapterGraph: async () => void imports++ });
		await runChapter(book, chapter, h.deps);
		assert.equal(imports, 0);
	});
	it("retries a lecture that cites an unknown node, with the validator's feedback, then accepts", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		const answers = [bad, draft];
		const h = harness();
		h.deps.writeLecture = async (input) => { h.calls.writes.push(input.feedback); return answers.shift()!; };
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.equal(h.calls.writes.length, 2);
		assert.equal(h.calls.writes[0], null);
		assert.match(h.calls.writes[1]!, /unknown node n_ghost000/);
	});
	it("fails the chapter after exactly 3 attempts and saves nothing for that lecture", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		let writes = 0;
		const h = harness({ writeLecture: async () => (writes++, bad) });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(writes, 3);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /stayed invalid after 3 attempts/);
		assert.equal(h.store.size, 0);
	});
	it("rejects a lecture that copies the chapter text verbatim", async () => {
		const source = "A sigma algebra is a family of sets closed under complements and countable unions of its members always.";
		const copy = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, text: source } : b)) };
		const h = harness({ readChapterText: async () => source, writeLecture: async () => copy });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /copies the source verbatim/);
	});
	it("writes lectures in sequence, handing each the previous summary, and reports uncovered chapter nodes", async () => {
		const h = harness({
			writeOutline: async () => Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })), // 3000 words -> 2 lectures
			readNodes: () => [node(NODE_A), node(NODE_B), node("n_orphan00")],
			findSourceId: () => SRC,
		});
		h.deps.writeLecture = async (input) => {
			h.calls.prevSummaries.push(input.previousSummary);
			return { ...draft, summary: `summary ${input.order}` };
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.deepEqual(h.calls.prevSummaries, [null, "summary 1"]);
		assert.equal(r.lectureIds.length, 2);
		assert.deepEqual(r.uncoveredNodeIds, ["n_orphan00"]);
	});
	it("replaces earlier lectures of the same chapter and keeps other chapters", async () => {
		const h = harness();
		h.store.set("lec_b0123abcd_c02_l09", makeLecture({ id: "lec_b0123abcd_c02_l09", order: 9 }));
		h.store.set("lec_b0123abcd_c03_l01", makeLecture({ id: "lec_b0123abcd_c03_l01", chapter: { ...chapter, index: 3 } }));
		await runChapter(book, chapter, h.deps);
		assert.deepEqual([...h.store.keys()].sort(), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c03_l01"]);
	});
	it("keeps the previous lectures of the chapter when a re-run fails midway", async () => {
		const h = harness({
			writeOutline: async () => Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })), // 2 lectures
		});
		const oldId = "lec_b0123abcd_c02_l09";
		h.store.set(oldId, makeLecture({ id: oldId, order: 9 }));
		let n = 0;
		h.deps.writeLecture = async () => { if (++n === 2) throw new Error("model down"); return draft; };
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.ok(h.store.has(oldId), "the previous lecture must survive a failed re-run");
		assert.ok(h.store.has("lec_b0123abcd_c02_l01"), "the first new lecture was saved before the failure");
	});
	it("fails without deleting anything when the outline yields no lecture", async () => {
		const h = harness({ writeOutline: async () => [] });
		const oldId = "lec_b0123abcd_c02_l09";
		h.store.set(oldId, makeLecture({ id: oldId, order: 9 }));
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /no lecture/);
		assert.ok(h.store.has(oldId), "the previous lecture must be kept");
	});
	it("stops with stopped_cost when the ceiling is reached, before any model call", async () => {
		const h = harness({ gate: { allowed: () => false, record: () => {} } });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.calls.imports + h.calls.outlines + h.calls.writes.length, 0);
	});
	it("treats a ceiling reached inside a writer as stopped_cost and keeps lectures already saved", async () => {
		const h = harness({
			writeOutline: async () => Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })),
		});
		let n = 0;
		h.deps.writeLecture = async () => { if (++n === 2) throw new CostCeilingError("spent"); return draft; };
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.store.size, 1);
	});
	it("fails clearly when the chapter graph is empty", async () => {
		const h = harness({ readNodes: () => [], findSourceId: () => SRC });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /graph is empty/);
	});
	it("labels the import with book and chapter", () => {
		assert.equal(chapterSourcePath(book, chapter), "Probability 1/02 Measurable spaces");
	});
	it("buildLecture output is what gets saved", async () => {
		const h = harness();
		await runChapter(book, chapter, h.deps);
		const meta = { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order: 1, chapterSourceId: SRC, createdAt: "2026-11-04T10:00:00.000Z" };
		assert.deepEqual(h.store.get("lec_b0123abcd_c02_l01"), buildLecture(draft, meta));
	});
});
