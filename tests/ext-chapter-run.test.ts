import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CostGate } from "../src/core/ext/cost-gate.ts";
import { buildLecture, type LectureDraft } from "../src/core/ext/lecture/build.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import {
	chapterSourceId,
	chapterSourcePath,
	runChapter,
	type ChapterProgress,
	type ChapterRunDeps,
	type GraphNodeView,
	type StagedChapterGraph,
} from "../src/agent/ext/lecture/chapter-run.ts";
import { CostCeilingError } from "../src/agent/ext/lecture/structured.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

const book = { bookId: "b0123abcd", bookTitle: "Probability 1" };
const chapter = { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 };
const SRC = chapterSourceId(book, chapter);
const NOW = "2026-11-04T10:00:00.000Z";

const nodeView = (id: string, source = SRC): GraphNodeView => ({ id, name: id, statement: `statement of ${id}`, provenance: [{ chatId: source, messageId: "" }] });
const base = makeLecture();
const draft: LectureDraft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };
const twoLectures = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })); // 3000 words -> 2 lectures

/**
 * A fake real graph and a fake staging overlay over it. The real graph is `realNodes`; a staged graph
 * sees real + its own nodes, and commit() moves its nodes into the real graph (recorded in `events`).
 */
function fakeGraph(realNodes: GraphNodeView[], events: string[], opts: { importsSource?: boolean; importNodes?: string[] } = {}) {
	const real = [...realNodes];
	let committedSource = false;
	const stage = (): StagedChapterGraph => {
		let staged: GraphNodeView[] = [];
		let imported = false;
		return {
			importText: async () => {
				events.push("import");
				imported = true;
				if (opts.importsSource === false) return;
				staged = (opts.importNodes ?? [NODE_A, NODE_B]).map((id) => nodeView(id));
			},
			hasSource: () => imported && opts.importsSource !== false,
			readNodes: () => [...real, ...staged],
			commit: () => {
				events.push("commit");
				real.push(...staged);
				staged = [];
				committedSource = true;
			},
			discard: () => {
				events.push("discard");
				staged = [];
			},
		};
	};
	return {
		real,
		stage,
		snapshot: () => JSON.stringify(real),
		activeGraph: (filePath: string) => (committedSource ? { sourceId: SRC, nodes: real.filter((n) => n.provenance.some((p) => p.chatId === SRC)) } : null),
		markCommitted: () => void (committedSource = true),
	};
}

function harness(over: Partial<ChapterRunDeps> = {}, graphOpts: { real?: GraphNodeView[]; importsSource?: boolean; importNodes?: string[] } = {}) {
	const store = new Map<string, Lecture>();
	const events: string[] = [];
	const calls = { outlines: 0, writes: [] as (string | null)[], prevSummaries: [] as (string | null)[], seenNodes: [] as string[][] };
	const graph = fakeGraph(graphOpts.real ?? [], events, graphOpts);
	const progress: ChapterProgress[] = [];
	const gate: CostGate = { allowed: () => true, record: () => {} };
	const deps: ChapterRunDeps = {
		gate,
		lectures: {
			save: (l) => {
				events.push(`save:${l.id}`);
				store.set(l.id, l);
			},
			list: () => [...store.values()],
			remove: (id) => void store.delete(id),
		},
		stageGraph: graph.stage,
		activeGraph: graph.activeGraph,
		readChapterText: async () => "Unrelated chapter source text that is never copied by the lecture.",
		writeOutline: async () => {
			calls.outlines++;
			return [{ title: "T", kind: "definition", summary: "s" }];
		},
		writeLecture: async (input) => {
			calls.writes.push(input.feedback);
			calls.prevSummaries.push(input.previousSummary);
			calls.seenNodes.push(input.nodes.map((n) => n.id));
			return draft;
		},
		now: () => NOW,
		onProgress: (p) => void progress.push(p),
		...over,
	};
	return { deps, store, calls, progress, events, graph };
}

describe("runChapter: the staged flow", () => {
	it("extracts into the staging overlay, writes the lecture, commits, and only then saves it", async () => {
		const h = harness();
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.deepEqual(r.lectureIds, ["lec_b0123abcd_c02_l01"]);
		assert.deepEqual(h.events, ["import", "commit", "save:lec_b0123abcd_c02_l01"], "import, then commit, then the save");
		assert.equal(h.store.get("lec_b0123abcd_c02_l01")?.chapterSourceId, SRC);
		assert.deepEqual(h.graph.real.map((n) => n.id), [NODE_A, NODE_B], "the chapter's nodes are active only after the commit");
		assert.deepEqual(r.uncoveredNodeIds, [], "the draft cites both chapter nodes");
		assert.deepEqual(h.progress.map((p) => p.state).slice(0, 4), ["queued", "graph", "outline", "writing"]);
	});
	it("the writers see the chapter's staged nodes, while the real graph holds none until the commit", async () => {
		const h = harness();
		const realSizes: number[] = [];
		h.deps.writeLecture = async (input) => {
			realSizes.push(h.graph.real.length);
			h.calls.seenNodes.push(input.nodes.map((n) => n.id));
			return draft;
		};
		await runChapter(book, chapter, h.deps);
		assert.deepEqual(h.calls.seenNodes[0], [NODE_A, NODE_B], "the chapter's own nodes are in its overlay");
		assert.deepEqual(realSizes, [0], "the real graph is empty while the lecture is written");
	});
	it("existing nodes linked by the chapter stay visible throughout, and are never changed", async () => {
		const real = [nodeView(NODE_A, "src_other00000"), nodeView(NODE_B, "src_other00000")];
		const before = JSON.stringify(real);
		const h = harness({}, { real, importNodes: ["n_newchap1"] });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		// The draft cites the existing nodes: the validator reads them through the overlay, so the run is done.
		assert.equal(r.state, "done", "the existing nodes are readable through the overlay while the chapter is written");
		assert.equal(JSON.stringify(h.graph.real.filter((n) => n.id === NODE_A || n.id === NODE_B)), before);
	});
	it("retries a lecture that cites an unknown node, with the validator's feedback, then accepts", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		const answers = [bad, draft];
		const h = harness();
		h.deps.writeLecture = async (input) => {
			h.calls.writes.push(input.feedback);
			return answers.shift()!;
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.equal(h.calls.writes.length, 2);
		assert.equal(h.calls.writes[0], null);
		assert.match(h.calls.writes[1]!, /unknown node n_ghost000/);
	});
	it("fails after exactly 3 attempts: nothing saved, nothing committed, the staging discarded", async () => {
		const bad = { ...draft, blocks: draft.blocks.map((b, i) => (i === 0 ? { ...b, nodeIds: ["n_ghost000"] } : b)) };
		let writes = 0;
		const h = harness({ writeLecture: async () => (writes++, bad) });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(writes, 3);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /stayed invalid after 3 attempts/);
		assert.equal(h.store.size, 0);
		assert.deepEqual(h.events, ["import", "discard"]);
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
		const h = harness({ writeOutline: async () => twoLectures }, { importNodes: [NODE_A, NODE_B, "n_orphan00"] });
		h.deps.writeLecture = async (input) => {
			h.calls.prevSummaries.push(input.previousSummary);
			return { ...draft, summary: `summary ${input.order}` };
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.deepEqual(h.calls.prevSummaries, [null, "summary 1"]);
		assert.equal(r.lectureIds.length, 2);
		assert.deepEqual(r.uncoveredNodeIds, ["n_orphan00"], "the chapter node no lecture cites is reported");
	});
	it("replaces earlier lectures of the same chapter and keeps other chapters", async () => {
		const h = harness();
		h.store.set("lec_b0123abcd_c02_l09", makeLecture({ id: "lec_b0123abcd_c02_l09", order: 9 }));
		h.store.set("lec_b0123abcd_c03_l01", makeLecture({ id: "lec_b0123abcd_c03_l01", chapter: { ...chapter, index: 3 } }));
		await runChapter(book, chapter, h.deps);
		assert.deepEqual([...h.store.keys()].sort(), ["lec_b0123abcd_c02_l01", "lec_b0123abcd_c03_l01"]);
	});
	it("builds the saved lecture from the draft, with the chapter's source id", async () => {
		const h = harness();
		await runChapter(book, chapter, h.deps);
		const meta = { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order: 1, chapterSourceId: SRC, createdAt: NOW };
		assert.deepEqual(h.store.get("lec_b0123abcd_c02_l01"), buildLecture(draft, meta));
	});
});

describe("runChapter: a chapter that does not finish leaves the real graph and the lectures as they were", () => {
	it("a failure while writing a later lecture: no node is active, no lecture is saved, the old lectures stay", async () => {
		const h = harness({ writeOutline: async () => twoLectures });
		const oldId = "lec_b0123abcd_c02_l09";
		h.store.set(oldId, makeLecture({ id: oldId, order: 9 }));
		const before = h.graph.snapshot();
		let n = 0;
		h.deps.writeLecture = async () => {
			if (++n === 2) throw new Error("model down");
			return draft;
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /model down/);
		assert.equal(h.graph.snapshot(), before, "the real graph is byte-identical");
		assert.deepEqual([...h.store.keys()], [oldId], "the first lecture was never saved; the old lecture is kept");
		assert.deepEqual(h.events, ["import", "discard"]);
	});
	it("an outline that yields no lecture fails without touching the real graph or the old lectures", async () => {
		const h = harness({ writeOutline: async () => [] });
		const oldId = "lec_b0123abcd_c02_l09";
		h.store.set(oldId, makeLecture({ id: oldId, order: 9 }));
		const before = h.graph.snapshot();
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /no lecture/);
		assert.equal(h.graph.snapshot(), before);
		assert.ok(h.store.has(oldId));
	});
	it("an abort midway (REQ-lec-18) stops with no further model call and leaves the real graph unchanged", async () => {
		const ac = new AbortController();
		const h = harness({ writeOutline: async () => Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, kind: "theorem" as const, summary: "s" })) });
		const before = h.graph.snapshot();
		let n = 0;
		h.deps.writeLecture = async () => {
			n++;
			if (n === 2) {
				ac.abort();
				ac.signal.throwIfAborted();
			}
			return draft;
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(n, 2, "no model call after the abort, and no retry of the aborted one");
		assert.equal(r.state, "failed");
		assert.match(r.error!, /abort/i);
		assert.equal(h.graph.snapshot(), before);
		assert.equal(h.store.size, 0);
		assert.equal(h.progress.at(-1)?.state, "failed");
	});
	it("a ceiling reached inside a writer is stopped_cost, and nothing is committed", async () => {
		const h = harness({ writeOutline: async () => twoLectures });
		const before = h.graph.snapshot();
		let n = 0;
		h.deps.writeLecture = async () => {
			if (++n === 2) throw new CostCeilingError("spent");
			return draft;
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.store.size, 0);
		assert.equal(h.graph.snapshot(), before);
	});
	it("stops with stopped_cost before any model call when the ceiling is reached", async () => {
		const h = harness({ gate: { allowed: () => false, record: () => {} } });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "stopped_cost");
		assert.equal(h.events.includes("import"), false, "no import before the ceiling check");
		assert.equal(h.calls.outlines, 0);
	});
	it("a commit that throws fails the chapter: nothing is saved and the staging is discarded", async () => {
		const h = harness();
		const stage = h.graph.stage;
		h.deps.stageGraph = () => {
			const s = stage();
			return { ...s, commit: () => { throw new Error("disk full"); } };
		};
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /disk full/);
		assert.equal(h.store.size, 0);
	});
	it("a chapter whose import left no source record fails clearly and commits nothing", async () => {
		const h = harness({}, { importsSource: false });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /left no source record/);
		assert.equal(h.events.includes("commit"), false);
	});
	it("fails clearly when the chapter graph is empty", async () => {
		const h = harness({}, { importNodes: [] });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /graph is empty/);
	});
});

describe("runChapter: a retry starts from scratch and never duplicates", () => {
	it("a failed chapter, retried, commits its graph exactly once", async () => {
		const real = [nodeView(NODE_A, "src_other00000")];
		const events: string[] = [];
		const graph = fakeGraph(real, events, { importNodes: [NODE_B] });
		// The first run fails at lecture 2 (staging discarded); the retry succeeds.
		const store = new Map<string, Lecture>();
		const deps = (failSecond: boolean): ChapterRunDeps => ({
			gate: { allowed: () => true, record: () => {} },
			lectures: { save: (l) => void store.set(l.id, l), list: () => [...store.values()], remove: (id) => void store.delete(id) },
			stageGraph: graph.stage,
			activeGraph: graph.activeGraph,
			readChapterText: async () => "Chapter.",
			writeOutline: async () => twoLectures,
			writeLecture: (() => {
				let n = 0;
				return async () => {
					if (failSecond && ++n === 2) throw new Error("model down");
					return draft;
				};
			})(),
			now: () => NOW,
		});
		const first = await runChapter(book, chapter, deps(true));
		assert.equal(first.state, "failed");
		assert.deepEqual(graph.real.map((n) => n.id), [NODE_A], "after the failure only the existing node remains");
		const second = await runChapter(book, chapter, deps(false));
		assert.equal(second.state, "done");
		assert.equal(graph.real.filter((n) => n.id === NODE_B).length, 1, "the chapter's node is active once, not twice");
		assert.equal(store.size, 2);
	});
});

describe("runChapter: an active chapter is skipped, a chapter whose lectures are gone is rebuilt", () => {
	it("a chapter whose graph is active and whose lectures are stored is done without any import", async () => {
		const h = harness();
		h.graph.markCommitted();
		h.store.set("lec_b0123abcd_c02_l01", makeLecture({ id: "lec_b0123abcd_c02_l01" }));
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.deepEqual(r.lectureIds, ["lec_b0123abcd_c02_l01"]);
		assert.equal(h.events.length, 0, "no import, no commit");
		assert.equal(h.calls.outlines, 0);
	});
	it("an active graph without stored lectures is rebuilt", async () => {
		const h = harness();
		h.graph.markCommitted();
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "done");
		assert.deepEqual(h.events.slice(0, 1), ["import"]);
	});
});

describe("runChapter: explained errors", () => {
	it("explains the stored error text: a repeated part once with its count, and the hint for a stop before the submit tool", async () => {
		const repeated = Array.from({ length: 6 }, () => "the extractor never submitted findings").join("; ");
		const h = harness({ writeOutline: async () => { throw new Error(repeated); } });
		const r = await runChapter(book, chapter, h.deps);
		assert.equal(r.state, "failed");
		assert.match(r.error!, /^the extractor never submitted findings \(x6\)\. The model stopped before calling the tool/);
		assert.equal(r.error!.split("never submitted").length - 1, 1);
		const outline = harness({ writeOutline: async () => { throw new Error("the model ended without calling submit_outline"); } });
		const r2 = await runChapter(book, chapter, outline.deps);
		assert.equal(r2.error!.split("The model stopped before calling the tool").length - 1, 1);
	});
	it("labels the import with book and chapter, and derives the source id from that label", () => {
		assert.equal(chapterSourcePath(book, chapter), "Probability 1/02 Measurable spaces");
		assert.match(chapterSourceId(book, chapter), /^src_[0-9a-f]{12}$/);
	});
});
