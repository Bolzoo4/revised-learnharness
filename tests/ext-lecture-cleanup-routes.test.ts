import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-cleanup-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const purge = await import("../app/api/ext/lectures/[id]/purge/route.ts");
const stale = await import("../app/api/ext/lectures/stale/route.ts");
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
const seed = (chapters: BookRunStatus["chapters"], phase: BookRunStatus["phase"] = "failed") =>
	registry.set(BOOK, { bookId: BOOK, title: "Probability 1", pdfPath: PDF, phase, chapters, startedAt: "2026-11-07T10:00:00.000Z" });

const purgeCall = (id: string, body: unknown) =>
	purge.POST(new Request(`http://localhost/api/ext/lectures/${id}/purge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
		params: Promise.resolve({ id }),
	});

describe("GET /api/ext/lectures/stale", () => {
	it("answers the list of chapters with leftovers: none here, so an empty list", async () => {
		registry.clear();
		seed([chapter(1, "done"), chapter(2, "failed")]);
		const res = await stale.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { chapters: [] }, "a failed chapter with nothing in the graph has no leftovers");
		registry.clear();
	});
});

describe("POST /api/ext/lectures/[id]/purge", () => {
	it("answers 200 with the removal counts for a failed chapter (nothing to remove: zeros)", async () => {
		registry.clear();
		seed([chapter(1, "done"), chapter(2, "failed")]);
		const res = await purgeCall(BOOK, { chapterIndex: 2 });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { nodesRemoved: 0, chainsRemoved: 0, nodesKept: 0 });
		registry.clear();
	});
	it("refuses with the status codes the route answers", async () => {
		registry.clear();
		seed([chapter(1, "done"), chapter(2, "failed")]);
		assert.equal((await purgeCall(BOOK, { chapterIndex: 0 })).status, 400, "a chapter index below 1");
		assert.equal((await purgeCall(BOOK, { chapterIndex: "2" })).status, 400, "a chapter index that is not a number");
		assert.equal((await purgeCall(BOOK, { chapterIndex: 9 })).status, 400, "an unknown chapter");
		assert.equal((await purgeCall("b00000000", { chapterIndex: 2 })).status, 404, "an unknown book");
		assert.equal((await purgeCall(BOOK, { chapterIndex: 1 })).status, 409, "a done chapter has no leftovers to remove");
		seed([chapter(1, "done"), chapter(2, "writing")], "running");
		assert.equal((await purgeCall(BOOK, { chapterIndex: 2 })).status, 409, "the book is still being made");
		registry.clear();
	});
	it("answers the refusal text as the error body, never an internal message", async () => {
		registry.clear();
		seed([chapter(1, "done"), chapter(2, "failed")], "running");
		const body = (await (await purgeCall(BOOK, { chapterIndex: 2 })).json()) as { error: string };
		assert.equal(body.error, "the book is still being made; retry when it finishes");
		registry.clear();
	});
});
