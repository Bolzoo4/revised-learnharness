// tests/ext-debrief-sessions.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DEBRIEF_CONFIG, readDebriefConfig } from "../src/core/ext/debrief/config.ts";
import { debriefId, type JournalEvent } from "../src/core/ext/debrief/journal.ts";
import { endedAtOf, ownerOfEvent, pendingSessions, type SessionRef } from "../src/core/ext/debrief/sessions.ts";

const MIN = 60_000;
const ref = (sessionId: string, startedAt: string, lastActivityAt: string, kind: SessionRef["kind"] = "review"): SessionRef => ({ sessionId, kind, title: sessionId, startedAt, lastActivityAt });
const NOW = new Date("2026-11-04T12:00:00.000Z");

describe("endedAtOf (REQ-deb-01: explicit end or inactivity)", () => {
	const r = ref("a", "2026-11-04T10:00:00.000Z", "2026-11-04T10:40:00.000Z");
	it("is open while the idle time has not passed", () => {
		assert.equal(endedAtOf(r, new Date("2026-11-04T11:09:59.000Z"), 30 * MIN, undefined), null);
	});
	it("ends at the last activity once the idle time has passed (boundary included)", () => {
		assert.equal(endedAtOf(r, new Date("2026-11-04T11:10:00.000Z"), 30 * MIN, undefined), "2026-11-04T10:40:00.000Z");
	});
	it("an explicit end wins, even while the session is still active", () => {
		assert.equal(endedAtOf(r, new Date("2026-11-04T10:41:00.000Z"), 30 * MIN, "2026-11-04T10:41:00.000Z"), "2026-11-04T10:41:00.000Z");
	});
	it("an explicit end before the start is clamped to the start", () => {
		assert.equal(endedAtOf(r, NOW, 30 * MIN, "2026-11-04T09:00:00.000Z"), "2026-11-04T10:00:00.000Z");
	});
	it("an unparseable explicit end falls back to the idle rule", () => {
		assert.equal(endedAtOf(r, NOW, 30 * MIN, "soon"), "2026-11-04T10:40:00.000Z");
	});
	it("unparseable session timestamps never end a session", () => {
		assert.equal(endedAtOf(ref("a", "bad", "2026-11-04T10:40:00.000Z"), NOW, 30 * MIN, "2026-11-04T11:00:00.000Z"), null);
		assert.equal(endedAtOf(ref("a", "2026-11-04T10:00:00.000Z", "bad"), NOW, 30 * MIN, undefined), null);
	});
	it("a NaN, zero or negative idle time never ends a session by inactivity", () => {
		for (const idle of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) assert.equal(endedAtOf(r, NOW, idle, undefined), null);
	});
});

describe("pendingSessions", () => {
	const base = { journal: [] as JournalEvent[], ends: new Map<string, string>(), now: NOW, idleMs: 30 * MIN, lookbackMs: 3 * 86_400_000 };
	const done = (sessionId: string): JournalEvent => ({
		id: debriefId(sessionId), kind: "session", sessionId, sessionKind: "review", weekOf: null, at: "2026-11-04T11:00:00.000Z",
		facts: { kind: "review" }, commentary: "## Observations\n\nx\n", nullReason: null, author: "agent",
	});
	it("lists ended sessions without a debrief, oldest end first", () => {
		const out = pendingSessions({
			...base,
			refs: [ref("late", "2026-11-04T09:00:00.000Z", "2026-11-04T10:00:00.000Z"), ref("early", "2026-11-04T07:00:00.000Z", "2026-11-04T08:00:00.000Z"), ref("open", "2026-11-04T11:50:00.000Z", "2026-11-04T11:55:00.000Z")],
		});
		assert.deepEqual(out.map((p) => p.ref.sessionId), ["early", "late"]);
	});
	it("skips a session that already has a debrief (idempotence)", () => {
		const out = pendingSessions({ ...base, journal: [done("a")], refs: [ref("a", "2026-11-04T07:00:00.000Z", "2026-11-04T08:00:00.000Z")] });
		assert.deepEqual(out, []);
	});
	it("lists a session id given twice once, the first listing winning", () => {
		const out = pendingSessions({ ...base, refs: [ref("a", "2026-11-04T07:00:00.000Z", "2026-11-04T08:00:00.000Z"), ref("a", "2026-11-04T05:00:00.000Z", "2026-11-04T06:00:00.000Z", "lecture")] });
		assert.equal(out.length, 1);
		assert.equal(out[0]?.ref.kind, "review");
	});
	it("ignores sessions older than the lookback, explicitly ended or not", () => {
		const old = ref("old", "2026-10-20T07:00:00.000Z", "2026-10-20T08:00:00.000Z");
		assert.deepEqual(pendingSessions({ ...base, refs: [old] }), []);
		// The lookback applies to explicitly ended sessions too (decision 2026-11-06: one rule for every session).
		const ends = new Map([["old", "2026-10-20T08:05:00.000Z"]]);
		assert.deepEqual(pendingSessions({ ...base, refs: [old], ends }), []);
	});
	it("returns nothing for no sessions", () => {
		assert.deepEqual(pendingSessions({ ...base, refs: [] }), []);
	});
});

describe("ownerOfEvent (a review is counted by one session only)", () => {
	const windows = [
		{ sessionId: "a", startedAt: "2026-11-04T10:00:00.000Z", endedAt: "2026-11-04T11:00:00.000Z" },
		{ sessionId: "b", startedAt: "2026-11-04T10:30:00.000Z", endedAt: "2026-11-04T11:30:00.000Z" },
	];
	it("the window that started last owns an overlapping event", () => {
		assert.equal(ownerOfEvent("2026-11-04T10:45:00.000Z", windows), "b");
		assert.equal(ownerOfEvent("2026-11-04T10:15:00.000Z", windows), "a");
		assert.equal(ownerOfEvent("2026-11-04T11:15:00.000Z", windows), "b");
	});
	it("the window edges belong to the window", () => {
		assert.equal(ownerOfEvent("2026-11-04T10:00:00.000Z", windows), "a");
		assert.equal(ownerOfEvent("2026-11-04T11:30:00.000Z", windows), "b");
	});
	it("an event outside every window, or with a bad timestamp, has no owner", () => {
		assert.equal(ownerOfEvent("2026-11-04T09:59:59.000Z", windows), null);
		assert.equal(ownerOfEvent("nope", windows), null);
		assert.equal(ownerOfEvent("2026-11-04T10:45:00.000Z", []), null);
	});
	it("equal starts go to the smaller session id", () => {
		const tie = [
			{ sessionId: "z", startedAt: "2026-11-04T10:00:00.000Z", endedAt: "2026-11-04T11:00:00.000Z" },
			{ sessionId: "m", startedAt: "2026-11-04T10:00:00.000Z", endedAt: "2026-11-04T11:00:00.000Z" },
		];
		assert.equal(ownerOfEvent("2026-11-04T10:30:00.000Z", tie), "m");
	});
});

describe("readDebriefConfig", () => {
	it("uses the defaults for an empty environment", () => {
		assert.deepEqual(readDebriefConfig({}), DEFAULT_DEBRIEF_CONFIG);
		assert.equal(DEFAULT_DEBRIEF_CONFIG.idleMs, 30 * MIN);
	});
	it("reads valid overrides", () => {
		const c = readDebriefConfig({ LH_EXT_DEBRIEF_IDLE_MIN: "45", LH_EXT_DEBRIEF_LOOKBACK_DAYS: "7", LH_EXT_WEEKLY_DAY: "5", LH_EXT_WEEKLY_HOUR: "9" }, 600);
		assert.deepEqual(c, { idleMs: 45 * MIN, lookbackMs: 7 * 86_400_000, weeklyDay: 5, weeklyHour: 9, budgetSec: 600 });
	});
	it("falls back for garbage, fractions and out-of-range values", () => {
		for (const bad of ["abc", "", " ", "0", "-5", "1.5", "99999", "NaN", "Infinity"]) {
			assert.equal(readDebriefConfig({ LH_EXT_DEBRIEF_IDLE_MIN: bad }).idleMs, 30 * MIN, bad);
		}
		assert.equal(readDebriefConfig({ LH_EXT_WEEKLY_DAY: "7" }).weeklyDay, 0);
		assert.equal(readDebriefConfig({ LH_EXT_WEEKLY_HOUR: "24" }).weeklyHour, 18);
		assert.equal(readDebriefConfig({}, Number.NaN).budgetSec, 1500);
		assert.equal(readDebriefConfig({}, -1).budgetSec, 1500);
	});
});
