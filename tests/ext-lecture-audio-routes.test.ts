import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import { makeLecture } from "./helpers/lecture-fixture.ts";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lecture-audio-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
delete process.env.DEEPGRAM_API_KEY;

const list = await import("../app/api/ext/lectures/route.ts");
const audio = await import("../app/api/ext/lectures/[id]/audio/route.ts");
const block = await import("../app/api/ext/lectures/[id]/audio/[blockId]/route.ts");
const { extStores } = await import("../src/server/ext/stores.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => {
	mock.restoreAll();
	delete process.env.DEEPGRAM_API_KEY;
});

const EN = [
	"The set is closed under complements and the union of two sets is a set of the algebra. This is the first step of the proof.",
	"We know that the family is closed under countable unions, and therefore it is a sigma algebra for the space.",
];
const LECTURE_ID = "lec_b0123abcd_c02_l01";

/** The English lecture of the fixture, saved straight to the store (no background audio). */
function saveLecture(): void {
	const base = makeLecture({ id: LECTURE_ID });
	extStores.lecturesStore.save({
		...base,
		blocks: EN.map((text, i) => ({ id: `b${i + 1}`, role: "narrate" as const, slideId: "s1", text, nodeIds: [], cues: [] })),
	});
}

function fakeDeepgram(): { calls: number } {
	const state = { calls: 0 };
	mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		state.calls++;
		const body = JSON.parse(String(init?.body)) as { text: string };
		return new Response(Buffer.alloc(body.text.length * 10, 3), { status: 200 });
	});
	return state;
}

const ctx = (id: string, blockId = "") => ({ params: Promise.resolve({ id, blockId }) });
const post = (body: unknown) => new Request(`http://localhost/api/ext/lectures/${LECTURE_ID}/audio`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("GET /lectures carries each lecture's audio state", () => {
	it("adds audio {ready, total, keyConfigured} to each lecture and keeps the existing fields", async () => {
		saveLecture();
		const body = await (await list.GET()).json();
		const lecture = body.lectures.find((l: { id: string }) => l.id === LECTURE_ID);
		assert.deepEqual(lecture.audio, { ready: 0, total: 2, keyConfigured: false });
		assert.equal(lecture.title, "Sigma algebras");
		assert.equal("blocks" in lecture, false);
	});
});

describe("GET /lectures/[id]/audio", () => {
	it("404 for an unknown lecture", async () => {
		const res = await audio.GET(new Request("http://localhost/x"), ctx("lec_b0123abcd_c09_l09"));
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "unknown lecture" });
	});
	it("reports the language, the voice, and every block missing with no key", async () => {
		saveLecture();
		const res = await audio.GET(new Request("http://localhost/x"), ctx(LECTURE_ID));
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.keyConfigured, false);
		assert.equal(body.language, "en");
		assert.equal(body.voice, "aura-2-thalia-en");
		assert.equal(body.ready, 0);
		assert.equal(body.total, 2);
		assert.deepEqual(body.statuses, [
			{ blockId: "b1", status: "missing" },
			{ blockId: "b2", status: "missing" },
		]);
		assert.equal(body.manifest, null);
	});
});

describe("POST /lectures/[id]/audio refusals", () => {
	it("no key: 503 for a block and for the batch, with the fixed text only", async () => {
		saveLecture();
		const one = await audio.POST(post({ blockId: "b1" }), ctx(LECTURE_ID));
		assert.equal(one.status, 503);
		const batch = await audio.POST(post({}), ctx(LECTURE_ID));
		assert.equal(batch.status, 503);
		const text = JSON.stringify(await batch.json());
		assert.ok(text.includes("no text-to-speech key"));
		assert.equal(text.includes("Token"), false);
	});
	it("a block that is not in this lecture is 404, and nothing is requested", async () => {
		saveLecture();
		process.env.DEEPGRAM_API_KEY = "dg_route_test_key_000000000000";
		const calls = fakeDeepgram();
		for (const blockId of ["b99", "../../secret", ""]) {
			const res = await audio.POST(post({ blockId }), ctx(LECTURE_ID));
			assert.equal(res.status, 404, blockId);
			assert.deepEqual(await res.json(), { error: "unknown block" });
		}
		assert.equal(calls.calls, 0);
	});
	it("400 for a malformed body or a non-string block id, without echoing the input", async () => {
		saveLecture();
		for (const body of ["{not json", "[]", { blockId: 5 }]) {
			const res = await audio.POST(post(body), ctx(LECTURE_ID));
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal((await res.text()).includes("not json"), false);
		}
	});
	it("404 for an unknown lecture", async () => {
		const res = await audio.POST(post({}), ctx("lec_b0123abcd_c09_l09"));
		assert.equal(res.status, 404);
	});
});

describe("POST /lectures/[id]/audio with a key", () => {
	it("generates one block on demand and answers with its chunk timings; the mp3 is then served", async () => {
		saveLecture();
		process.env.DEEPGRAM_API_KEY = "dg_route_test_key_000000000000";
		const calls = fakeDeepgram();
		const res = await audio.POST(post({ blockId: "b1" }), ctx(LECTURE_ID));
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.block.status, "ready");
		assert.equal(body.block.chunks[0].startChar, 0);
		const afterFirst = calls.calls;
		assert.ok(afterFirst >= 1);

		// a second request for the same block is free: no more calls
		const again = await audio.POST(post({ blockId: "b1" }), ctx(LECTURE_ID));
		assert.equal(again.status, 200);
		assert.equal(calls.calls, afterFirst);

		const file = await block.GET(new Request("http://localhost/x"), ctx(LECTURE_ID, "b1"));
		assert.equal(file.status, 200);
		assert.equal(file.headers.get("content-type"), "audio/mpeg");
		assert.equal(file.headers.get("accept-ranges"), "bytes");
		assert.equal(file.headers.get("cache-control"), "private, max-age=3600");
		const bytes = Buffer.from(await file.arrayBuffer());
		assert.equal(bytes.length, Number(file.headers.get("content-length")));
		assert.equal(bytes.length, body.block.chunks.reduce((s: number, c: { bytes: number }) => s + c.bytes, 0));
	});

	it("honours a Range header: a part of the file, or 416 when unsatisfiable", async () => {
		saveLecture();
		process.env.DEEPGRAM_API_KEY = "dg_route_test_key_000000000000";
		fakeDeepgram();
		await audio.POST(post({ blockId: "b1" }), ctx(LECTURE_ID));
		const whole = Buffer.from(await (await block.GET(new Request("http://localhost/x"), ctx(LECTURE_ID, "b1"))).arrayBuffer());

		const part = await block.GET(new Request("http://localhost/x", { headers: { range: "bytes=0-3" } }), ctx(LECTURE_ID, "b1"));
		assert.equal(part.status, 206);
		assert.equal(part.headers.get("content-range"), `bytes 0-3/${whole.length}`);
		assert.deepEqual(Buffer.from(await part.arrayBuffer()), whole.subarray(0, 4));

		const bad = await block.GET(new Request("http://localhost/x", { headers: { range: `bytes=${whole.length + 10}-` } }), ctx(LECTURE_ID, "b1"));
		assert.equal(bad.status, 416);
		assert.equal(bad.headers.get("content-range"), `bytes */${whole.length}`);
	});

	it("the mp3 route answers 404 for a foreign block, and for a block that has no audio yet", async () => {
		saveLecture();
		const foreign = await block.GET(new Request("http://localhost/x"), ctx(LECTURE_ID, "../../etc/passwd"));
		assert.equal(foreign.status, 404);
		assert.deepEqual(await foreign.json(), { error: "unknown block" });
		const notReady = await block.GET(new Request("http://localhost/x"), ctx(LECTURE_ID, "b2"));
		assert.equal(notReady.status, 404);
		assert.deepEqual(await notReady.json(), { error: "no audio for this block" });
		const unknownLecture = await block.GET(new Request("http://localhost/x"), ctx("lec_b0123abcd_c09_l09", "b1"));
		assert.equal(unknownLecture.status, 404);
	});

	it("POST {} starts the missing blocks in the background (202), and the state reaches ready", async () => {
		saveLecture();
		process.env.DEEPGRAM_API_KEY = "dg_route_test_key_000000000000";
		fakeDeepgram();
		const res = await audio.POST(post({}), ctx(LECTURE_ID));
		assert.equal(res.status, 202);
		let state = await (await audio.GET(new Request("http://localhost/x"), ctx(LECTURE_ID))).json();
		for (let i = 0; i < 100 && state.ready < state.total; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			state = await (await audio.GET(new Request("http://localhost/x"), ctx(LECTURE_ID))).json();
		}
		assert.equal(state.ready, 2);
		assert.equal(state.keyConfigured, true);
		assert.deepEqual(
			state.statuses.map((s: { status: string }) => s.status),
			["ready", "ready"],
		);
		assert.equal(state.manifest.blocks.length, 2);
		assert.ok(fs.existsSync(path.join(TMP_DATA, "ext", "lecture-audio", LECTURE_ID, "b2.mp3")));
	});
});
