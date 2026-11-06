// tests/ext-debrief-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-debrief-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const list = await import("../app/api/ext/debriefs/route.ts");
const byId = await import("../app/api/ext/debriefs/[id]/route.ts");
const end = await import("../app/api/ext/debriefs/end/route.ts");
const sweep = await import("../app/api/ext/debriefs/sweep/route.ts");
const activity = await import("../app/api/ext/debriefs/activity/route.ts");
const { debriefService } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const quiet = () => mock.method(console, "error", () => {});

async function assertInternal(res: Response) {
	assert.equal(res.status, 500);
	const text = await res.text();
	assert.deepEqual(JSON.parse(text), { error: "internal error" });
	assert.ok(!text.includes("secret") && !text.includes(" at "));
}

describe("GET /api/ext/debriefs", () => {
	it("answers an empty history with the bounded shape", async () => {
		const res = await list.GET(new Request("http://localhost/api/ext/debriefs"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { entries: [], count: 0, truncated: false, open: [] });
	});
	it("rejects a bad query with 400", async () => {
		for (const q of ["limit=abc", "kind=nope", "since=never"]) assert.equal((await list.GET(new Request(`http://localhost/api/ext/debriefs?${q}`))).status, 400);
	});
	it("hides an internal failure behind a generic 500", async () => {
		quiet();
		mock.method(debriefService, "list", () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await list.GET(new Request("http://localhost/api/ext/debriefs")));
	});
});

describe("GET /api/ext/debriefs/[id]", () => {
	it("is a 404 for an unknown id", async () => {
		const res = await byId.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "deb_000000000000" }) });
		assert.equal(res.status, 404);
	});
});

describe("POST /api/ext/debriefs/end", () => {
	it("400 for a malformed body or a bad id, 404 for an unknown session", async () => {
		assert.equal((await end.POST(post("/e", "not json"))).status, 400);
		assert.equal((await end.POST(post("/e", []))).status, 400);
		assert.equal((await end.POST(post("/e", {}))).status, 400);
		assert.equal((await end.POST(post("/e", { sessionId: "has space" }))).status, 400);
		assert.equal((await end.POST(post("/e", { sessionId: "chat_unknown" }))).status, 404);
	});
	it("hides an internal failure behind a generic 500", async () => {
		quiet();
		mock.method(debriefService, "endSession", async () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await end.POST(post("/e", { sessionId: "chat_a" })));
	});
});

describe("POST /api/ext/debriefs/sweep and /activity", () => {
	it("a sweep on empty data creates nothing", async () => {
		const res = await sweep.POST();
		assert.equal(res.status, 200);
		const json = (await res.json()) as { created: number; errors: number };
		assert.equal(json.created, 0);
		assert.equal(json.errors, 0);
	});
	it("activity: 400 for malformed input, 404 for an unknown lecture", async () => {
		assert.equal((await activity.POST(post("/a", {}))).status, 400);
		assert.equal((await activity.POST(post("/a", { type: "lecture_view", sessionId: "lecs_abcdefgh12", lectureId: "lec_b00000000_c01_l01", slideId: "s1" }))).status, 404);
	});
	it("a failing sweep is a generic 500", async () => {
		quiet();
		mock.method(debriefService, "sweep", async () => { throw new Error("boom: /secret/path"); });
		await assertInternal(await sweep.POST());
	});
});
