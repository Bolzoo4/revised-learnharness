import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSourceLibrary } from "../src/core/ext/sources.ts";
import type { Lecture } from "../src/core/ext/lecture/lecture.ts";
import { bookIdFor, createLectureService, LectureServiceError, type BookRunStatus, type LectureServiceDeps } from "../src/server/ext/lecture-service.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";
import { memSourcesStore } from "./helpers/ext-fakes.ts";

const PDF = "/books/prob.pdf";
const SRC = "src_0123456789ab";
const base = makeLecture();
const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };

function setup(over: Partial<LectureServiceDeps> = {}) {
	const store = new Map<string, Lecture>();
	const runs = new Map<string, BookRunStatus>();
	let imported = false;
	const deps: LectureServiceDeps = {
		lectures: { save: (l) => void store.set(l.id, l), get: (id) => store.get(id) ?? null, list: () => [...store.values()].sort((a, b) => a.id.localeCompare(b.id)), remove: (id) => void store.delete(id) },
		gate: { allowed: () => true, record: () => {} },
		graphNodes: () => (imported ? [NODE_A, NODE_B].map((id) => ({ id, name: id, statement: "s", provenance: [{ chatId: SRC, messageId: "" }] })) : []),
		importChapterGraph: async () => void (imported = true),
		findSourceId: () => (imported ? SRC : null),
		pdf: {
			exists: (p) => p === PDF,
			readBookmarks: async () => ({ pageCount: 20, bookmarks: [{ title: "Measurable spaces", page: 1 }] }),
			readPageTexts: async () => [],
			readChapterText: async () => "Unrelated source text for this chapter.",
		},
		writers: {
			detectChaptersWithLlm: async () => [],
			writeOutline: async () => [{ title: "t", kind: "definition", summary: "s" }],
			writeLecture: async () => draft,
		},
		runs,
		now: () => "2026-11-04T10:00:00.000Z",
		...over,
	};
	return { svc: createLectureService(deps), store, runs };
}

describe("startBookIngest", () => {
	it("runs the book in the background and ends with phase done and saved lectures", async () => {
		const { svc, store, runs } = setup();
		const { bookId, finished } = svc.startBookIngest({ pdfPath: PDF });
		assert.equal(bookId, bookIdFor(PDF));
		assert.equal(runs.get(bookId)!.phase, "detecting");
		await finished;
		const s = runs.get(bookId)!;
		assert.equal(s.phase, "done");
		assert.equal(s.title, "prob");
		assert.deepEqual(s.chapters.map((c) => c.state), ["done"]);
		assert.equal(store.size, 1);
	});
	it("registers the book as an active primary source when a library is present", async () => {
		const library = createSourceLibrary(memSourcesStore());
		const { svc } = setup({ library });
		await svc.startBookIngest({ pdfPath: PDF, title: "Probability 1" }).finished;
		assert.deepEqual(library.list().map((e) => [e.locator, e.tier, e.status]), [[PDF, "primary", "active"]]);
	});
	it("is single-flight per book", async () => {
		const { svc } = setup();
		const a = svc.startBookIngest({ pdfPath: PDF });
		const b = svc.startBookIngest({ pdfPath: PDF });
		await b.finished;
		await a.finished;
		assert.equal(svc.runStatuses().length, 1);
	});
	it("marks the run failed when some chapter fails", async () => {
		const { svc, runs } = setup({ writers: { detectChaptersWithLlm: async () => [], writeOutline: async () => { throw new Error("boom"); }, writeLecture: async () => draft } });
		const { bookId, finished } = svc.startBookIngest({ pdfPath: PDF });
		await finished;
		assert.equal(runs.get(bookId)!.phase, "failed");
		assert.match(runs.get(bookId)!.chapters[0]!.error!, /boom/);
	});
	it("a run-level failure stores a fixed message, not the raw error text, and logs the real one", async () => {
		const logged: unknown[][] = [];
		const orig = console.error;
		console.error = (...a: unknown[]) => void logged.push(a);
		try {
			const { svc, runs } = setup({ pdf: { exists: (p) => p === PDF, readBookmarks: async () => { throw new Error("secret /path/boom"); }, readPageTexts: async () => [], readChapterText: async () => "" } });
			const { bookId, finished } = svc.startBookIngest({ pdfPath: PDF });
			await finished;
			const st = runs.get(bookId)!;
			assert.equal(st.phase, "failed");
			assert.ok(st.error && !st.error.includes("secret"));
			assert.ok(logged.some((a) => a.some((x) => String(x).includes("secret /path/boom"))));
		} finally {
			console.error = orig;
		}
	});
	it("refuses relative paths, non-pdf files, missing files and a spent ceiling", () => {
		const { svc } = setup({ gate: { allowed: () => false, record: () => {} } });
		const code = (f: () => unknown): number => { try { f(); } catch (e) { return (e as LectureServiceError).status; } return 0; };
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "rel/x.pdf" })), 400);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "/x/notes.txt" })), 400);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: "/x/missing.pdf" })), 404);
		assert.equal(code(() => svc.startBookIngest({ pdfPath: PDF })), 429);
	});
});

describe("read queries", () => {
	it("derives the overlay and the back-links from the stored lectures", async () => {
		const { svc } = setup();
		await svc.startBookIngest({ pdfPath: PDF }).finished;
		assert.equal(svc.overlay().nodes.length, 1);
		assert.deepEqual(svc.overlay().edges.map((e) => e.to), [NODE_A, NODE_B]);
		assert.equal(svc.citing(NODE_A).length, 1);
		assert.equal(svc.citing("n_nobody00").length, 0);
		assert.equal(svc.getLecture(svc.listLectures()[0]!.id)?.title, base.title);
	});
});
