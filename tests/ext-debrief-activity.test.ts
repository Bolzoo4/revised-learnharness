import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	alreadyRecorded,
	deriveLectureSessions,
	explicitEnds,
	parseActivityEvent,
	type ActivityEvent,
} from "../src/core/ext/debrief/activity.ts";

const S = "lecs_abcdefgh12";
const view = (slideId: string, at: string, sessionId = S, lectureId = "lec_b1_c01_l01"): Extract<ActivityEvent, { type: "lecture_view" }> => ({ type: "lecture_view", sessionId, lectureId, slideId, at });

describe("parseActivityEvent", () => {
	it("accepts the four event types", () => {
		assert.ok(parseActivityEvent({ type: "lecture_view", sessionId: S, lectureId: "L", slideId: "s1", at: "2026-11-04T10:00:00.000Z" }));
		assert.ok(parseActivityEvent({ type: "concept_open", sessionId: S, lectureId: "L", nodeId: "n_1", at: "2026-11-04T10:00:00.000Z" }));
		assert.ok(parseActivityEvent({ type: "exercise_done", sessionId: S, lectureId: "L", blockId: "b1", at: "2026-11-04T10:00:00.000Z" }));
		assert.ok(parseActivityEvent({ type: "end", sessionId: "chat_ab_12345678", at: "2026-11-04T10:00:00.000Z" }));
	});
	it("rejects malformed events", () => {
		const at = "2026-11-04T10:00:00.000Z";
		const bad: unknown[] = [
			null, 3, {},
			{ type: "end", sessionId: "", at },
			{ type: "end", sessionId: "has space", at },
			{ type: "end", sessionId: "x".repeat(101), at },
			{ type: "end", sessionId: "chat_a", at: "soon" },
			{ type: "lecture_view", sessionId: "chat_a", lectureId: "L", slideId: "s", at }, // not a lecture session id
			{ type: "lecture_view", sessionId: S, lectureId: "", slideId: "s", at },
			{ type: "lecture_view", sessionId: S, lectureId: "L", slideId: "", at },
			{ type: "lecture_view", sessionId: S, lectureId: "L", slideId: "s".repeat(201), at },
			{ type: "lecture_view", sessionId: S, lectureId: "L", at },
			{ type: "concept_open", sessionId: S, lectureId: "L", slideId: "s", at },
			{ type: "other", sessionId: S, lectureId: "L", at },
		];
		for (const b of bad) assert.equal(parseActivityEvent(b), null, JSON.stringify(b));
	});
});

describe("deriveLectureSessions", () => {
	it("collects distinct slides, concepts and exercises and the activity span", () => {
		const events: ActivityEvent[] = [
			view("s1", "2026-11-04T10:05:00.000Z"),
			view("s1", "2026-11-04T10:06:00.000Z"),
			view("s2", "2026-11-04T10:00:00.000Z"),
			{ type: "concept_open", sessionId: S, lectureId: "lec_b1_c01_l01", nodeId: "n_1", at: "2026-11-04T10:07:00.000Z" },
			{ type: "exercise_done", sessionId: S, lectureId: "lec_b1_c01_l01", blockId: "b3", at: "2026-11-04T10:08:00.000Z" },
		];
		const [s] = deriveLectureSessions(events);
		assert.deepEqual([...s!.slides].sort(), ["s1", "s2"]);
		assert.deepEqual([...s!.concepts], ["n_1"]);
		assert.deepEqual([...s!.exercises], ["b3"]);
		assert.equal(s!.startedAt, "2026-11-04T10:00:00.000Z");
		assert.equal(s!.lastActivityAt, "2026-11-04T10:08:00.000Z");
	});
	it("the first event fixes the lecture; later events naming another lecture are ignored", () => {
		const [s] = deriveLectureSessions([view("s1", "2026-11-04T10:00:00.000Z"), view("s9", "2026-11-04T11:00:00.000Z", S, "lec_other")]);
		assert.equal(s!.lectureId, "lec_b1_c01_l01");
		assert.deepEqual([...s!.slides], ["s1"]);
		assert.equal(s!.lastActivityAt, "2026-11-04T10:00:00.000Z");
	});
	it("ignores end events and keeps sessions apart", () => {
		const out = deriveLectureSessions([view("s1", "2026-11-04T10:00:00.000Z"), view("s1", "2026-11-04T10:00:00.000Z", "lecs_zzzzzzzz99"), { type: "end", sessionId: S, at: "2026-11-04T10:30:00.000Z" }]);
		assert.equal(out.length, 2);
	});
});

describe("explicitEnds and alreadyRecorded", () => {
	it("the earliest end of a session wins, whatever the file order", () => {
		const ends = explicitEnds([
			{ type: "end", sessionId: "a", at: "2026-11-04T12:00:00.000Z" },
			{ type: "end", sessionId: "a", at: "2026-11-04T11:00:00.000Z" },
			{ type: "end", sessionId: "b", at: "2026-11-04T09:00:00.000Z" },
		]);
		assert.equal(ends.get("a"), "2026-11-04T11:00:00.000Z");
		assert.equal(ends.size, 2);
	});
	it("a repeated lecture event is recognised, a different target is not", () => {
		const existing = [view("s1", "2026-11-04T10:00:00.000Z")];
		assert.equal(alreadyRecorded(existing, view("s1", "2026-11-04T10:05:00.000Z")), true);
		assert.equal(alreadyRecorded(existing, view("s2", "2026-11-04T10:05:00.000Z")), false);
		assert.equal(alreadyRecorded(existing, view("s1", "2026-11-04T10:05:00.000Z", "lecs_other12345")), false);
		assert.equal(alreadyRecorded(existing, { type: "concept_open", sessionId: S, lectureId: "lec_b1_c01_l01", nodeId: "s1", at: "2026-11-04T10:00:00.000Z" }), false);
		assert.equal(alreadyRecorded([{ type: "end", sessionId: S, at: "2026-11-04T10:00:00.000Z" }], view("s1", "2026-11-04T10:00:00.000Z")), false);
	});
});
