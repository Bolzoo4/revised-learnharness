import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { INTERRUPTED_TEXT, type BookRun, type LectureRunStore } from "../src/core/ext/lecture/run-record.ts";
import { bookIdFor, createLectureService, LectureServiceError, type BookRunStatus, type LectureServiceDeps } from "../src/server/ext/lecture-service.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { fakeStagedGraphs } from "./helpers/staged-graph-fake.ts";

const PDF = "/books/prob.pdf";
const BOOK = bookIdFor(PDF);
const base = makeLecture();
const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };
const T0 = "2026-11-06T10:00:00.000Z";

/** An in-memory run store: what the service saved, and what a restart would load. */
function memRunStore(initial: BookRun[] = []) {
	let saved: BookRun[] = structuredClone(initial);
	let loads = 0;
	const store: LectureRunStore = {
		load: () => (loads++, structuredClone(saved)),
		save: (books) => void (saved = structuredClone([...books])),
	};
	return { store, saved: () => saved, loads: () => loads };
}

const mkBook = (over: Partial<BookRun> = {}): BookRun => ({
	bookId: BOOK,
	title: "Probability 1",
	pdfPath: PDF,
	phase: "failed",
	chapters: [
		{ chapter: { index: 1, title: "Measurable spaces", pageStart: 1, pageEnd: 9 }, state: "done", lectures: 1, uncovered: 0 },
		{ chapter: { index: 2, title: "Sigma algebras", pageStart: 10, pageEnd: 19 }, state: "failed", stage: "outline", lectures: 0, uncovered: 0, error: "boom", startedAt: T0, updatedAt: T0 },
		{ chapter: { index: 3, title: "Measures", pageStart: 20, pageEnd: 29 }, state: "stopped_cost", stage: "writing", lectures: 0, uncovered: 0, startedAt: T0, updatedAt: T0 },
	],
	startedAt: T0,
	...over,
});

function setup(over: Partial<LectureServiceDeps> & { run?: BookRun[]; exists?: boolean; gateOpen?: boolean } = {}) {
	const lines: string[] = [];
	const runStore = memRunStore(over.run ?? []);
	const graph = fakeStagedGraphs();
	const lectures = new Map<string, Lecture>();
	const runs = new Map<string, BookRunStatus>();
	let outlineFails = false;
	const deps: LectureServiceDeps = {
		lectures: { save: (l) => void lectures.set(l.id, l), get: (id) => lectures.get(id) ?? null, list: () => [...lectures.values()], remove: (id) => void lectures.delete(id) },
		gate: { allowed: () => over.gateOpen ?? true, record: () => {} },
		graphNodes: graph.graphNodes,
		stageGraph: graph.stageGraph,
		activeGraph: graph.activeGraph,
		pdf: {
			exists: (p) => (over.exists ?? true) && p === PDF,
			readBookmarks: async () => ({ pageCount: 40, bookmarks: [{ title: "Measurable spaces", page: 1 }, { title: "Sigma algebras", page: 10 }, { title: "Measures", page: 20 }] }),
			readPageTexts: async () => [],
			readChapterText: async () => "Unrelated source text for this chapter.",
		},
		writers: {
			detectChaptersWithLlm: async () => [],
			writeOutline: async () => {
				if (outlineFails) throw new Error("the model ended without calling submit_outline");
				return [{ title: "t", kind: "definition", summary: "s" }];
			},
			writeLecture: async () => draft,
		},
		runs,
		runStore: runStore.store,
		log: (line) => void lines.push(line),
		now: () => T0,
		...over,
	};
	const svc = createLectureService(deps);
	return {
		svc,
		runs,
		lines,
		imports: graph.imports,
		runStore,
		setOutlineFails: (v: boolean) => (outlineFails = v),
		graph,
	};
}

describe("persistence and the chapter log", () => {
	it("saves the state on every change and logs one line per final chapter outcome, without the path", async () => {
		const h = setup();
		const { finished } = h.svc.startBookIngest({ pdfPath: PDF });
		await finished;
		const last = h.runStore.saved().find((b) => b.bookId === BOOK)!;
		assert.equal(last.phase, "done");
		assert.equal(h.lines.length, 3);
		assert.equal(h.lines.every((l) => l.startsWith(`[lectures] book ${BOOK} chapter `)), true);
		const first = h.lines.find((l) => l.includes(" chapter 1 "))!;
		assert.ok(first.endsWith(`"Measurable spaces" done (stage writing, 0s)`), first);
		assert.ok(h.lines.every((l) => !l.includes(PDF) && !l.includes("Unrelated source")));
	});
	it("writes the line to console.log by default (the desktop app keeps it in main.log)", async () => {
		const captured: string[] = [];
		const orig = console.log;
		console.log = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
		try {
			const h = setup({ log: undefined });
			h.setOutlineFails(true);
			await h.svc.startBookIngest({ pdfPath: PDF }).finished;
		} finally {
			console.log = orig;
		}
		const lines = captured.filter((l) => l.startsWith("[lectures] "));
		assert.equal(lines.length, 3);
		assert.ok(lines.every((l) => / (done|failed|stopped_cost|stopped_provider|interrupted)(: .*)? \(stage /.test(l)), lines.join("\n"));
		assert.ok(lines.every((l) => !l.includes(PDF)));
	});
	it("logs a failed chapter with the explained error and the stage it stopped at", async () => {
		const h = setup();
		h.setOutlineFails(true);
		await h.svc.startBookIngest({ pdfPath: PDF }).finished;
		const line = h.lines.find((l) => l.includes(`chapter 1 `))!;
		assert.match(line, /"Measurable spaces" failed: the model ended without calling submit_outline\. The model stopped before calling the tool\. This usually means it ran out of output space: lower the thinking level or choose a model with a larger output limit in Settings\. \(stage outline, 0s\)$/);
	});
	it("a graph import that fails leaves nothing active: the chapter is failed with the explained error", async () => {
		const failing = fakeStagedGraphs({ importError: new Error("model down") });
		const h = setup({ stageGraph: failing.stageGraph });
		await h.svc.startBookIngest({ pdfPath: PDF }).finished;
		const saved = h.runStore.saved().find((b) => b.bookId === BOOK)!;
		assert.equal(saved.chapters[0]!.state, "failed");
		assert.match(saved.chapters[0]!.error!, /model down/);
		assert.equal(failing.committed.size, 0, "no chapter graph was committed");
	});
});

describe("restart", () => {
	it("restores the books and chapters on start; a run in flight becomes interrupted and is logged once", () => {
		const running = mkBook({
			phase: "running",
			error: undefined,
			chapters: [
				{ chapter: { index: 1, title: "Measurable spaces", pageStart: 1, pageEnd: 9 }, state: "done", lectures: 1, uncovered: 0 },
				{ chapter: { index: 2, title: "Sigma algebras", pageStart: 10, pageEnd: 19 }, state: "outline", stage: "outline", lectures: 0, uncovered: 0, startedAt: T0, updatedAt: "2026-11-06T10:00:41.000Z" },
				{ chapter: { index: 3, title: "Measures", pageStart: 20, pageEnd: 29 }, state: "queued", lectures: 0, uncovered: 0 },
			],
		});
		const h = setup({ run: [running], now: () => "2026-11-07T08:00:00.000Z" });
		const restored = h.runs.get(BOOK)!;
		assert.equal(restored.phase, "interrupted");
		assert.equal(restored.error, INTERRUPTED_TEXT);
		assert.deepEqual(restored.chapters.map((c) => c.state), ["done", "interrupted", "interrupted"]);
		assert.equal(h.svc.runStatuses().length, 1, "the lectures page can show the book after a restart");
		assert.equal(h.lines.length, 2);
		assert.equal(h.lines[0], `[lectures] book ${BOOK} chapter 2 "Sigma algebras" interrupted: ${INTERRUPTED_TEXT} (stage outline, 41s)`);
		// the saved state is now interrupted, so a second start logs nothing again
		const saved = h.runStore.saved();
		assert.equal(saved[0]!.phase, "interrupted");
		const again = setup({ run: saved, now: () => "2026-11-07T09:00:00.000Z" });
		assert.equal(again.lines.length, 0);
		assert.equal(again.runs.get(BOOK)!.phase, "interrupted");
	});
	it("a finished book is restored as it was, with nothing logged", () => {
		const h = setup({ run: [mkBook({ phase: "done", chapters: [mkBook().chapters[0]!] })] });
		assert.equal(h.runs.get(BOOK)!.phase, "done");
		assert.equal(h.lines.length, 0);
	});
	it("a store that cannot be read starts empty, without a crash", () => {
		const runs = new Map<string, BookRunStatus>();
		const throwing: LectureRunStore = { load: () => { throw new Error("unreadable"); }, save: () => {} };
		const svc = createLectureService({
			lectures: { save: () => {}, get: () => null, list: () => [], remove: () => {} },
			gate: { allowed: () => true, record: () => {} },
			graphNodes: () => [],
			stageGraph: () => {
				throw new Error("not used: the store cannot be read");
			},
			activeGraph: () => null,
			pdf: { exists: () => true, readBookmarks: async () => ({ pageCount: 1, bookmarks: [] }), readPageTexts: async () => [], readChapterText: async () => "" },
			writers: { detectChaptersWithLlm: async () => [], writeOutline: async () => [], writeLecture: async () => draft },
			runs,
			runStore: throwing,
			log: () => {},
		});
		assert.deepEqual(svc.runStatuses(), []);
	});
});

describe("retryChapters", () => {
	it("re-runs every failed, interrupted or stopped chapter from the start, and ends with the book's phase", async () => {
		const h = setup({ run: [mkBook()] });
		const { chapters, finished } = h.svc.retryChapters(BOOK);
		assert.deepEqual(chapters, [2, 3]);
		assert.equal(h.runs.get(BOOK)!.phase, "running");
		await finished;
		const book = h.runs.get(BOOK)!;
		assert.deepEqual(book.chapters.map((c) => c.state), ["done", "done", "done"]);
		assert.equal(book.phase, "done");
		assert.equal(book.error, undefined);
		assert.equal(h.imports.length, 2, "each retried chapter is imported once, from the start");
	});
	it("re-runs one chapter when its index is given, and only that one", async () => {
		const h = setup({ run: [mkBook()] });
		const { chapters, finished } = h.svc.retryChapters(BOOK, 2);
		assert.deepEqual(chapters, [2]);
		await finished;
		assert.equal(h.runs.get(BOOK)!.chapters[2]!.state, "stopped_cost", "chapter 3 is not touched");
	});
	it("refuses with the status codes the route answers", () => {
		const code = (f: () => unknown): number => {
			try {
				f();
			} catch (e) {
				return (e as LectureServiceError).status;
			}
			return 0;
		};
		const h = setup({ run: [mkBook()] });
		assert.equal(code(() => h.svc.retryChapters("b00000000")), 404);
		assert.equal(code(() => h.svc.retryChapters(BOOK, 99)), 400);
		assert.equal(code(() => h.svc.retryChapters(BOOK, 1)), 409, "chapter 1 is done");
		const running = setup({ run: [mkBook()] });
		running.runs.set(BOOK, mkBook({ phase: "running" }));
		assert.equal(code(() => running.svc.retryChapters(BOOK)), 409, "a book still being made is not retried");
		const busy = setup({ run: [mkBook()] });
		busy.runs.set(BOOK, mkBook({ chapters: [{ ...mkBook().chapters[1]!, state: "writing" }] }));
		assert.equal(code(() => busy.svc.retryChapters(BOOK, 2)), 409, "a running chapter");
		const none = setup({ run: [mkBook({ chapters: [mkBook().chapters[0]!] })] });
		assert.equal(code(() => none.svc.retryChapters(BOOK)), 409, "nothing needs a retry");
		const gone = setup({ run: [mkBook()], exists: false });
		assert.equal(code(() => gone.svc.retryChapters(BOOK)), 409, "the PDF is no longer stored");
		const spent = setup({ run: [mkBook()], gateOpen: false });
		assert.equal(code(() => spent.svc.retryChapters(BOOK)), 429);
	});
});
