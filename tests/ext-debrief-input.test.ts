// tests/ext-debrief-input.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/server/ext/http-error.ts";
import { outcomeResponse, parseLectureActivity, parseListQuery } from "../src/server/ext/debrief-input.ts";

const bad = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400);
const q = (s: string) => new URLSearchParams(s);

describe("parseListQuery", () => {
	it("reads limit, kind and since", () => {
		assert.deepEqual(parseListQuery(q("limit=5&kind=weekly&since=2026-11-01T00:00:00Z")), { limit: 5, kind: "weekly", since: "2026-11-01T00:00:00Z" });
		assert.deepEqual(parseListQuery(q("")), {});
		assert.equal(parseListQuery(q("kind=review")).kind, "review");
	});
	it("refuses a bad limit, kind or date without echoing it", () => {
		for (const s of ["limit=abc", "limit=0", "limit=-1", "limit=1.5", "limit=", "kind=teaching", "kind=", "since=yesterday", "since="]) bad(() => parseListQuery(q(s)));
		try { parseListQuery(q("kind=SECRET-VALUE")); } catch (e) { assert.ok(!(e as Error).message.includes("SECRET")); }
	});
});

describe("parseLectureActivity", () => {
	const base = { sessionId: "lecs_abcdefgh12", lectureId: "L" };
	it("accepts the three event types", () => {
		assert.deepEqual(parseLectureActivity({ ...base, type: "lecture_view", slideId: "s1" }), { type: "lecture_view", ...base, slideId: "s1" });
		assert.deepEqual(parseLectureActivity({ ...base, type: "concept_open", nodeId: "n" }), { type: "concept_open", ...base, nodeId: "n" });
		assert.deepEqual(parseLectureActivity({ ...base, type: "exercise_done", blockId: "b" }), { type: "exercise_done", ...base, blockId: "b" });
	});
	it("refuses missing, non-string, empty and oversized fields and unknown types", () => {
		bad(() => parseLectureActivity({}));
		bad(() => parseLectureActivity({ ...base, type: "lecture_view" }));
		bad(() => parseLectureActivity({ ...base, type: "lecture_view", slideId: 5 }));
		bad(() => parseLectureActivity({ ...base, type: "lecture_view", slideId: "" }));
		bad(() => parseLectureActivity({ ...base, type: "lecture_view", slideId: "x".repeat(201) }));
		bad(() => parseLectureActivity({ ...base, type: "end", slideId: "s" }));
		bad(() => parseLectureActivity({ sessionId: 3, lectureId: "L", type: "lecture_view", slideId: "s" }));
	});
});

describe("outcomeResponse", () => {
	it("maps each outcome to a status and never carries an error text", () => {
		assert.equal(outcomeResponse({ status: "empty" }).status, 200);
		assert.equal(outcomeResponse({ status: "deferred", reason: "retry" }).status, 202);
		assert.deepEqual(outcomeResponse({ status: "deferred", reason: "unavailable" }).body, { status: "deferred", reason: "unavailable" });
	});
});
