import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const lectures = await import("../app/api/ext/lectures/route.ts");
const lectureById = await import("../app/api/ext/lectures/[id]/route.ts");
const overlay = await import("../app/api/ext/lectures/overlay/route.ts");
const exercises = await import("../app/api/ext/exercises/route.ts");
const officeHours = await import("../app/api/ext/office-hours/route.ts");
const marks = await import("../app/api/ext/review/marks/route.ts");
const plan = await import("../app/api/ext/review/plan/route.ts");
const reviewSession = await import("../app/api/ext/review/session/route.ts");
const { lectureService, practiceService, personalLayer, HttpError, httpErrorResponse } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const quiet = () => mock.method(console, "error", () => {});

/** A thrown non-HttpError must be a 500 with a generic body: no message, no stack. */
async function assertInternal(res: Response, secret = "boom: /secret/path") {
	assert.equal(res.status, 500);
	const text = await res.text();
	assert.deepEqual(JSON.parse(text), { error: "internal error" });
	assert.ok(!text.includes(secret) && !text.includes(" at "));
}

describe("httpErrorResponse", () => {
	it("maps an HttpError to its status and message", async () => {
		for (const status of [400, 404, 409]) {
			const res = httpErrorResponse(new HttpError(status, "nope"));
			assert.equal(res.status, status);
			assert.deepEqual(await res.json(), { error: "nope" });
		}
	});
	it("maps anything else to a generic 500", async () => {
		quiet();
		await assertInternal(httpErrorResponse(new Error("boom: /secret/path")));
		await assertInternal(httpErrorResponse("a string"), "a string");
	});
});

describe("lectures routes", () => {
	it("GET /lectures lists runs and lectures", async () => {
		const res = await lectures.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { runs: [], lectures: [] });
	});
	it("GET /lectures hides internal failures behind a 500", async () => {
		quiet();
		mock.method(lectureService, "listLectures", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await lectures.GET());
	});
	it("POST /lectures: 400 on a malformed body, a missing or relative pdfPath", async () => {
		for (const body of ["{not json", "[]", "null", {}, { pdfPath: "rel/book.pdf" }, { pdfPath: "/books/x.txt" }]) {
			const res = await lectures.POST(post("/api/ext/lectures", body));
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal(typeof (await res.json()).error, "string");
		}
	});
	it("POST /lectures: 404 when the PDF does not exist", async () => {
		const res = await lectures.POST(post("/api/ext/lectures", { pdfPath: "/nonexistent/book.pdf" }));
		assert.equal(res.status, 404);
	});
	it("POST /lectures: an unexpected failure is a generic 500", async () => {
		quiet();
		mock.method(lectureService, "startBookIngest", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await lectures.POST(post("/api/ext/lectures", { pdfPath: "/a.pdf" })));
	});
	it("GET /lectures/[id]: 404 for an unknown lecture", async () => {
		const res = await lectureById.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "unknown lecture" });
	});
	it("GET /lectures/[id]: a thrown error is a generic 500", async () => {
		quiet();
		mock.method(lectureService, "getLecture", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await lectureById.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "a" }) }));
	});
	it("GET /lectures/overlay: 200 with nodes and edges; a thrown error is a generic 500", async () => {
		const ok = await overlay.GET();
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { nodes: [], edges: [] });
		quiet();
		mock.method(lectureService, "overlay", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await overlay.GET());
	});
});

describe("exercises route", () => {
	it("GET lists sets (empty at start); a thrown error is a generic 500", async () => {
		const res = await exercises.GET(new Request("http://localhost/api/ext/exercises"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { sets: [] });
		quiet();
		mock.method(practiceService, "listSets", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await exercises.GET(new Request("http://localhost/api/ext/exercises")));
	});
	it("POST: 400 on a malformed body, or a count that is present but not a positive integer", async () => {
		for (const body of ["{not json", "[]", { goalId: "g", count: "3" }, { goalId: "g", count: 0 }, { goalId: "g", count: 2.5 }]) {
			const res = await exercises.POST(post("/api/ext/exercises", body));
			assert.equal(res.status, 400, JSON.stringify(body));
		}
	});
	it("POST: 404 for an unknown goal", async () => {
		const res = await exercises.POST(post("/api/ext/exercises", { goalId: "g_missing" }));
		assert.equal(res.status, 404);
	});
	it("POST: an unexpected failure is a generic 500, not a 400", async () => {
		quiet();
		mock.method(practiceService, "createExerciseSet", async () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await exercises.POST(post("/api/ext/exercises", { goalId: "g" })));
	});
});

describe("office-hours route", () => {
	it("POST: 201 for a free session", async () => {
		const res = await officeHours.POST(post("/api/ext/office-hours", { label: "Manual", sourceText: "A passage." }));
		assert.equal(res.status, 201);
		assert.equal(typeof (await res.json()).chatId, "string");
	});
	it("POST: 400 on a malformed body or a missing label", async () => {
		for (const body of ["{not json", "[]", {}, { label: "  " }]) {
			assert.equal((await officeHours.POST(post("/api/ext/office-hours", body))).status, 400, JSON.stringify(body));
		}
	});
	it("POST: 404 for an unknown exercise set", async () => {
		const res = await officeHours.POST(post("/api/ext/office-hours", { setId: "set_x", exerciseId: "e1" }));
		assert.equal(res.status, 404);
	});
	it("POST: an unexpected failure is a generic 500, not a 400", async () => {
		quiet();
		mock.method(practiceService, "startSession", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await officeHours.POST(post("/api/ext/office-hours", { label: "x" })));
	});
});

describe("review routes", () => {
	it("GET /review/plan: 200 with the plan and goal readiness (capacity is always a whole number)", async () => {
		const res = await plan.GET();
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.ok(Array.isArray(body.items) && Array.isArray(body.goals));
		assert.ok(Number.isInteger(body.capacity));
	});
	it("GET /review/plan: a thrown error is a generic 500", async () => {
		quiet();
		mock.method(personalLayer, "plan", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await plan.GET());
	});
	it("POST /review/session: 200 with a chatId; a thrown error is a generic 500", async () => {
		const res = await reviewSession.POST(post("/api/ext/review/session", {}));
		assert.equal(res.status, 200);
		assert.equal(typeof (await res.json()).chatId, "string");
		quiet();
		mock.method(personalLayer, "startReviewSession", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await reviewSession.POST(post("/api/ext/review/session", {})));
	});
	it("POST /review/marks: 400 for a malformed body or an invalid mark", async () => {
		for (const body of ["{not json", "null", {}, { nodeId: "n" }, { goalId: "g", retention: "high" }]) {
			assert.equal((await marks.POST(post("/api/ext/review/marks", body))).status, 400, JSON.stringify(body));
		}
	});
	it("POST /review/marks: 404 for an unknown node or goal, 400 for an out-of-range retention", async () => {
		assert.equal((await marks.POST(post("/api/ext/review/marks", { nodeId: "n_missing", pinned: true }))).status, 404);
		assert.equal((await marks.POST(post("/api/ext/review/marks", { goalId: "g_missing", retention: 0.9 }))).status, 404);
		assert.equal((await marks.POST(post("/api/ext/review/marks", { goalId: "g_missing", retention: 5 }))).status, 400);
	});
	it("POST /review/marks: an unexpected failure is a generic 500, not a 400", async () => {
		quiet();
		mock.method(personalLayer, "mark", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await marks.POST(post("/api/ext/review/marks", { nodeId: "n", pinned: true })));
	});
});
