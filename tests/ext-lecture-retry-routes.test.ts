import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-retry-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const retry = await import("../app/api/ext/lectures/[id]/retry/route.ts");
const { lectureService, HttpError } = await import("../src/server/index.ts");
type BookRunStatus = import("../src/core/ext/lecture/run-record.ts").BookRun;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

// The live run registry (lecture-live.ts keeps it on globalThis): seeded here, never started.
const registry = (globalThis as { __lhExtLectureRuns?: Map<string, BookRunStatus> }).__lhExtLectureRuns!;
const BOOK = "b0123abcd";
const PDF = path.join(TMP_DATA, "book.pdf");
const chapter = (index: number, state: BookRunStatus["chapters"][number]["state"]) => ({
	chapter: { index, title: `Chapter ${index}`, pageStart: index * 10, pageEnd: index * 10 + 9 },
	state,
	lectures: 0,
	uncovered: 0,
});
const book = (over: Partial<BookRunStatus> = {}): BookRunStatus => ({
	bookId: BOOK,
	title: "Probability 1",
	pdfPath: PDF,
	phase: "failed",
	chapters: [chapter(1, "done"), chapter(2, "failed")],
	startedAt: "2026-11-06T10:00:00.000Z",
	...over,
});

const call = (id: string, body: unknown) =>
	retry.POST(new Request(`http://localhost/api/ext/lectures/${id}/retry`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), {
		params: Promise.resolve({ id }),
	});

beforeEach(() => {
	fs.writeFileSync(PDF, "%PDF-1.4\n");
	registry.delete(BOOK);
});
after(() => registry.delete(BOOK));

describe("POST /api/ext/lectures/[id]/retry", () => {
	it("404 for an unknown book", async () => {
		const res = await call("b99999999", {});
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "unknown book" });
	});
	it("400 for a bad index: not a whole number, below 1, or not a chapter of the book", async () => {
		registry.set(BOOK, book());
		for (const chapterIndex of ["2", 0, -1, 1.5, null, true]) {
			const res = await call(BOOK, { chapterIndex });
			assert.equal(res.status, 400, JSON.stringify(chapterIndex));
		}
		const unknown = await call(BOOK, { chapterIndex: 9 });
		assert.equal(unknown.status, 400);
		assert.deepEqual(await unknown.json(), { error: "unknown chapter" });
	});
	it("400 for a body that is not a JSON object", async () => {
		registry.set(BOOK, book());
		assert.equal((await call(BOOK, "[1]")).status, 400);
		assert.equal((await call(BOOK, "not json")).status, 400);
	});
	it("409 when nothing needs a retry, or the requested chapter is done", async () => {
		registry.set(BOOK, book({ chapters: [chapter(1, "done")], phase: "done" }));
		const none = await call(BOOK, {});
		assert.equal(none.status, 409);
		assert.deepEqual(await none.json(), { error: "no chapter needs a retry" });
		const done = await call(BOOK, { chapterIndex: 1 });
		assert.equal(done.status, 409);
		assert.deepEqual(await done.json(), { error: "that chapter does not need a retry" });
	});
	it("409 when the book is still being made, or its PDF is no longer stored", async () => {
		registry.set(BOOK, book({ phase: "running" }));
		const busy = await call(BOOK, {});
		assert.equal(busy.status, 409);
		registry.set(BOOK, book({ pdfPath: path.join(TMP_DATA, "moved-away.pdf") }));
		const gone = await call(BOOK, {});
		assert.equal(gone.status, 409);
		assert.deepEqual(await gone.json(), { error: "the book PDF is no longer stored" });
	});
	it("409 for a requested chapter that is already running", async () => {
		registry.set(BOOK, book({ chapters: [chapter(1, "done"), { ...chapter(2, "writing") }] }));
		const res = await call(BOOK, { chapterIndex: 2 });
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: "that chapter is already running" });
	});
	it("429 when the daily ceiling is spent, with the service's fixed text", async () => {
		registry.set(BOOK, book());
		mock.method(lectureService, "retryChapters", () => {
			throw new HttpError(429, "the daily ceiling for background model work is spent");
		});
		const res = await call(BOOK, {});
		assert.equal(res.status, 429);
	});
	it("202 with the chapters started, and the work runs in the background", async () => {
		registry.set(BOOK, book());
		const started = mock.method(lectureService, "retryChapters", () => ({ chapters: [2], finished: Promise.resolve() }));
		const res = await call(BOOK, { chapterIndex: 2 });
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { bookId: BOOK, chapters: [2] });
		assert.deepEqual(started.mock.calls[0]!.arguments, [BOOK, 2]);
	});
	it("202 with no index starts every chapter that needs a retry", async () => {
		registry.set(BOOK, book());
		const started = mock.method(lectureService, "retryChapters", () => ({ chapters: [2], finished: Promise.resolve() }));
		const res = await call(BOOK, {});
		assert.equal(res.status, 202);
		assert.deepEqual(started.mock.calls[0]!.arguments, [BOOK, undefined]);
	});
});
