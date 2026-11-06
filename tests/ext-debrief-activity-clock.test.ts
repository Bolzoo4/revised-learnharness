// tests/ext-debrief-activity-clock.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActivityEvent } from "../src/core/ext/debrief/activity.ts";
import { DEFAULT_DEBRIEF_CONFIG } from "../src/core/ext/debrief/config.ts";
import { createDebriefService, newDebriefState } from "../src/server/ext/debrief-service.ts";
import { fakeGate } from "./helpers/ext-fakes.ts";
import { fakeSources, fakeWriter, local, memLedger, ref } from "./helpers/debrief-fakes.ts";
import { makeLecture, NODE_A } from "./helpers/lecture-fixture.ts";

const lecture = makeLecture();
const S = "lecs_abcdefgh12";
const STAMP = "2026-11-04T12:00:00.000Z";

/**
 * The live wiring passes `now: liveNow`, which scans every source. These counters
 * stand in for that scan: `now` calls and `sources.sessions()` calls are both counted.
 */
function build(opts: { clock?: () => string; refs?: ReturnType<typeof ref>[] } = {}) {
	const sources = fakeSources(opts.refs ?? [ref("chat_a", local(11, 4, 11, 50))]);
	const scanned = { sessions: 0, now: 0 };
	const sessions = sources.sessions;
	sources.sessions = () => {
		scanned.sessions += 1;
		return sessions();
	};
	const activity = memLedger<ActivityEvent>();
	const service = createDebriefService({
		journal: memLedger(),
		activity,
		sources,
		writer: fakeWriter(),
		gate: fakeGate(true),
		config: DEFAULT_DEBRIEF_CONFIG,
		lecture: (id) => (id === lecture.id ? lecture : null),
		now: () => {
			scanned.now += 1;
			return local(11, 4, 12);
		},
		...(opts.clock ? { clock: opts.clock } : {}),
		state: newDebriefState(),
	});
	return { service, activity, scanned };
}

describe("activity stamps use the cheap clock, not the sweep clock (REQ-deb-01, debrief cost)", () => {
	it("recording lecture activity never runs the sweep clock or scans the sources", () => {
		const h = build({ clock: () => STAMP });
		assert.deepEqual(h.service.recordLectureActivity({ type: "lecture_view", sessionId: S, lectureId: lecture.id, slideId: lecture.slides[0]!.id }), { recorded: true });
		assert.deepEqual(h.service.recordLectureActivity({ type: "concept_open", sessionId: S, lectureId: lecture.id, nodeId: NODE_A }), { recorded: true });
		assert.equal(h.scanned.now, 0, "the sweep clock (liveNow) was not called");
		assert.equal(h.scanned.sessions, 0, "no source was scanned");
		assert.deepEqual(h.activity.events.map((e) => e.at), [STAMP, STAMP]);
	});

	it("a burst of player events stays scan-free", () => {
		const h = build({ clock: () => STAMP });
		for (let i = 0; i < 50; i += 1) {
			assert.deepEqual(h.service.recordLectureActivity({ type: "lecture_view", sessionId: S, lectureId: lecture.id, slideId: lecture.slides[0]!.id }), { recorded: i === 0 });
		}
		assert.equal(h.scanned.sessions + h.scanned.now, 0);
	});

	it("ending a session stamps the end with the cheap clock and never calls the sweep clock", async () => {
		const h = build({ clock: () => STAMP });
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "created");
		assert.equal(h.scanned.now, 0);
		const end = h.activity.events.find((e) => e.type === "end");
		assert.equal(end?.at, STAMP);
	});

	it("without an injected clock the stamp is the current system time, still with no scan", () => {
		const h = build();
		const before = Date.now();
		h.service.recordLectureActivity({ type: "lecture_view", sessionId: S, lectureId: lecture.id, slideId: lecture.slides[0]!.id });
		const at = Date.parse(h.activity.events[0]!.at);
		assert.ok(at >= before && at <= Date.now() + 1000, "stamp is the system time");
		assert.equal(h.scanned.now + h.scanned.sessions, 0);
	});

	it("the sweep still uses the sweep clock (sanity: the scan path is not removed)", async () => {
		const h = build({ clock: () => STAMP });
		await h.service.sweep();
		assert.ok(h.scanned.now > 0, "sweep reads the sweep clock");
	});
});
