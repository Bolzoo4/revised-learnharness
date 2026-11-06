import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { makeLecture } from "./helpers/lecture-fixture.ts";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-oh-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const lectures = await import("../app/api/ext/lectures/route.ts");
const officeHours = await import("../app/api/ext/lectures/[id]/office-hours/route.ts");
const { extStores } = await import("../src/server/ext/stores.ts");
const { practiceService } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const LECTURE_ID = "lec_b0123abcd_c02_l01";
const post = (body: unknown) => new Request(`http://localhost/api/ext/lectures/${LECTURE_ID}/office-hours`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const call = (id: string, req: Request) => officeHours.POST(req, { params: Promise.resolve({ id }) });

describe("GET /lectures carries each lecture's exercises", () => {
	it("keeps the existing fields and adds bookId and exercises [{blockId, prompt}]", async () => {
		extStores.lecturesStore.save(makeLecture());
		const body = await (await lectures.GET()).json();
		const lecture = body.lectures.find((l: { id: string }) => l.id === LECTURE_ID);
		assert.equal(lecture.title, "Sigma algebras");
		assert.equal(lecture.bookTitle, "Probability 1");
		assert.equal(lecture.bookId, "b0123abcd");
		assert.deepEqual(lecture.chapter, { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 });
		assert.equal(lecture.order, 1);
		assert.deepEqual(lecture.exercises, [{ blockId: "b2", prompt: "Try it yourself on a three element set." }]);
		assert.equal("blocks" in lecture, false);
	});
});

describe("POST /lectures/[id]/office-hours", () => {
	it("404 for an unknown lecture, and nothing is started", async () => {
		const start = mock.method(practiceService, "startSession", () => ({ chatId: "x", label: "x" }));
		const res = await call("lec_missing", post({ blockId: "b2" }));
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "unknown lecture" });
		assert.equal(start.mock.callCount(), 0);
	});
	it("404 for a block id that is not an exercise of this lecture (foreign or unknown)", async () => {
		const start = mock.method(practiceService, "startSession", () => ({ chatId: "x", label: "x" }));
		for (const blockId of ["b99", "b_other_lecture"]) {
			const res = await call(LECTURE_ID, post({ blockId }));
			assert.equal(res.status, 404);
			assert.deepEqual(await res.json(), { error: "unknown exercise" });
		}
		assert.equal(start.mock.callCount(), 0);
	});
	it("400 for a block of this lecture that is not an exercise", async () => {
		const res = await call(LECTURE_ID, post({ blockId: "b1" }));
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "that block is not an exercise" });
	});
	it("400 for a malformed body or a missing block id, without echoing the input", async () => {
		for (const body of ["{not json", "[]", {}, { blockId: 5 }, { blockId: "" }]) {
			const res = await call(LECTURE_ID, post(body));
			assert.equal(res.status, 400, JSON.stringify(body));
			const text = await res.text();
			assert.equal(text.includes("not json"), false);
		}
	});
	it("409 with the fixed message when the chapter text cannot be found (no book PDF stored), and no session is created", async () => {
		const start = mock.method(practiceService, "startSession", () => ({ chatId: "x", label: "x" }));
		const res = await call(LECTURE_ID, post({ blockId: "b2" }));
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: "the chapter text is not available: its book PDF is no longer stored" });
		assert.equal(start.mock.callCount(), 0);
	});
});
