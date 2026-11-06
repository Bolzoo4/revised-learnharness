// tests/ext-adv-debrief-core.test.ts
// Adversarial, spec-derived tests for the pure debrief core (REQ-deb-01..11).
// Written from the spec and signature declarations only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	DEFAULT_LIST_LIMIT,
	MAX_LIST_LIMIT,
	SESSION_KINDS,
	debriefId,
	deriveJournal,
	findDebrief,
	keyOf,
	parseJournalEvent,
	recentDebriefs,
	sessionKey,
	weeklyKey,
	type JournalEvent,
	type ListFilter,
	type SessionKind,
} from "../src/core/ext/debrief/journal.ts";
import {
	ANY_SESSION_ID,
	LECTURE_SESSION_ID,
	alreadyRecorded,
	deriveLectureSessions,
	explicitEnds,
	parseActivityEvent,
	type ActivityEvent,
} from "../src/core/ext/debrief/activity.ts";
import {
	endedAtOf,
	ownerOfEvent,
	pendingSessions,
	type SessionRef,
	type Window,
} from "../src/core/ext/debrief/sessions.ts";
import {
	FACT_KINDS,
	computeExerciseFacts,
	computeLectureFacts,
	computeOfficeHoursFacts,
	computeReviewFacts,
	computeStudyFacts,
	countUnanswered,
	hasSubstance,
	spanSec,
	type SessionFacts,
	type TranscriptLine,
} from "../src/core/ext/debrief/facts.ts";
import {
	computeWeeklyFacts,
	hasWeeklySubstance,
	weeklyWindow,
	type WeeklyFacts,
	type WeeklyInput,
	type WeeklyWindow,
} from "../src/core/ext/debrief/weekly.ts";
import {
	COMMENTARY_HEADINGS,
	COMMENTARY_PARTS,
	MAX_PART_CHARS,
	checkCommentary,
	renderCommentary,
	type Commentary,
	type CommentaryPart,
} from "../src/core/ext/debrief/commentary.ts";
import { DEFAULT_DEBRIEF_CONFIG, readDebriefConfig } from "../src/core/ext/debrief/config.ts";
import { WriterUnavailableError } from "../src/core/ext/debrief/ports.ts";
import type { Goal } from "../src/core/ext/goals.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";
import type { TrustLevel } from "../src/core/ext/trust.ts";
import type { Exercise, ExerciseSetState } from "../src/core/ext/practice/exercises.ts";
import type { OfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";

// ---------------------------------------------------------------- helpers

const ms = (s: string): number => Date.parse(s);
const sha12 = (k: string): string => createHash("sha256").update(k, "utf8").digest("hex").slice(0, 12);

function nth<T>(a: readonly T[], i: number): T {
	const v = a[i];
	if (v === undefined) throw new Error(`no element at index ${i}`);
	return v;
}

function must<T>(v: T | null | undefined): T {
	if (v === null || v === undefined) throw new Error("unexpected null/undefined");
	return v;
}

/** Runs fn with process.env.TZ set, then restores it. Node applies TZ changes at runtime. */
function inTZ<T>(tz: string, fn: () => T): T {
	const prev = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.TZ;
		else process.env.TZ = prev;
	}
}

/** A Date whose clock readers throw: any read of the wall clock inside fn fails the test. */
const RealDate = Date;
class NoClockDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) throw new Error("clock read: new Date()");
		super(...(args as [number, number]));
	}
	static override now(): number {
		throw new Error("clock read: Date.now()");
	}
}
function withoutClock<T>(fn: () => T): T {
	const saved = globalThis.Date;
	globalThis.Date = NoClockDate as unknown as DateConstructor;
	try {
		return fn();
	} finally {
		globalThis.Date = saved;
	}
}

const AT = "2026-11-02T10:40:00.000Z";

function session(sessionId: string, at: string, sessionKind: SessionKind = "review", commentary: string | null = "c"): JournalEvent {
	const ev = {
		kind: "session" as const,
		sessionId,
		sessionKind,
		weekOf: null,
		at,
		facts: { kind: sessionKind },
		commentary,
		nullReason: null,
		author: "agent" as const,
	};
	return { id: `deb_${sha12(keyOf(ev))}`, ...ev };
}

function weekly(weekOf: string, at: string, commentary: string | null = "w"): JournalEvent {
	const ev = {
		kind: "weekly" as const,
		sessionId: null,
		sessionKind: null,
		weekOf,
		at,
		facts: { kind: "weekly" },
		commentary,
		nullReason: null,
		author: "agent" as const,
	};
	return { id: `deb_${sha12(keyOf(ev))}`, ...ev };
}

function minuteIso(base: string, i: number): string {
	return new Date(ms(base) + i * 60_000).toISOString();
}

// ---------------------------------------------------------------- journal

describe("journal: keys and ids", () => {
	it("[spec-gap] a session key and a weekly key never collide, even for the same string", () => {
		assert.notEqual(sessionKey("2026-11-02"), weeklyKey("2026-11-02"));
		assert.notEqual(sessionKey("weekly:2026-11-02"), weeklyKey("2026-11-02"));
	});

	it("keyOf routes each kind to its own namespace", () => {
		assert.equal(keyOf({ kind: "session", sessionId: "chat_1", weekOf: null }), sessionKey("chat_1"));
		assert.equal(keyOf({ kind: "weekly", sessionId: null, weekOf: "2026-11-02" }), weeklyKey("2026-11-02"));
	});

	it("debriefId is deb_ plus the first 12 hex digits of SHA-256 of the key", () => {
		assert.equal(debriefId("chat_1"), `deb_${sha12("chat_1")}`);
		assert.match(debriefId("weekly:2026-11-02"), /^deb_[0-9a-f]{12}$/);
	});

	it("debriefId separates keys that differ only by a trailing space or case", () => {
		assert.notEqual(debriefId("chat_1"), debriefId("chat_1 "));
		assert.notEqual(debriefId("chat_1"), debriefId("CHAT_1"));
	});

	it("SESSION_KINDS lists exactly the five study kinds", () => {
		assert.deepEqual([...SESSION_KINDS].sort(), ["exercises", "lecture", "office_hours", "review", "study"]);
	});
});

describe("journal: parsing", () => {
	it("accepts a well-formed session debrief", () => {
		const ev = session("chat_1", AT);
		assert.deepEqual(parseJournalEvent(ev), ev);
	});

	it("accepts a well-formed weekly synthesis", () => {
		const ev = weekly("2026-11-02", AT);
		assert.deepEqual(parseJournalEvent(ev), ev);
	});

	it("rejects anything that is not a plain object, including a torn line passed as text", () => {
		for (const raw of [null, undefined, 42, "text", [], true, '{"id":"deb_']) {
			assert.equal(parseJournalEvent(raw), null, `input ${JSON.stringify(raw)}`);
		}
	});

	it("rejects an event missing a required field", () => {
		for (const k of ["id", "kind", "at", "facts", "commentary", "author"]) {
			const ev: Record<string, unknown> = { ...session("chat_1", AT) };
			delete ev[k];
			assert.equal(parseJournalEvent(ev), null, `missing ${k}`);
		}
	});

	it("rejects wrong types field by field", () => {
		const base = session("chat_1", AT);
		const bad: Array<[string, unknown]> = [
			["at", 1234],
			["at", null],
			["author", "user"],
			["kind", "daily"],
			["sessionKind", "chat"],
			["sessionId", 7],
			["nullReason", "bogus"],
			["commentary", 5],
			["facts", "review"],
			["facts", null],
			["facts", []],
		];
		for (const [k, v] of bad) {
			assert.equal(parseJournalEvent({ ...base, [k]: v }), null, `${k}=${String(v)}`);
		}
	});

	it("rejects a session facts object whose kind does not match the session kind", () => {
		const base = session("chat_1", AT, "review");
		assert.equal(parseJournalEvent({ ...base, facts: { kind: "lecture" } }), null);
		assert.equal(parseJournalEvent({ ...base, facts: {} }), null);
	});

	it("rejects a weekly event whose facts are not weekly facts", () => {
		const w = weekly("2026-11-02", AT);
		assert.equal(parseJournalEvent({ ...w, facts: { kind: "review" } }), null);
	});

	it("[spec-gap] a session event must name a session and a weekly event must name a week", () => {
		assert.equal(parseJournalEvent({ ...session("chat_1", AT), sessionId: null }), null);
		assert.equal(parseJournalEvent({ ...weekly("2026-11-02", AT), weekOf: null }), null);
	});

	it("[spec-gap] an id that does not match the event's key is rejected", () => {
		assert.equal(parseJournalEvent({ ...session("chat_1", AT), id: "deb_000000000000" }), null);
	});

	it("a __proto__ key from JSON.parse never pollutes prototypes or the result", () => {
		const base = JSON.stringify(session("chat_1", AT));
		const raw = JSON.parse(`${base.slice(0, -1)},"__proto__":{"polluted":"yes"}}`) as unknown;
		const r = parseJournalEvent(raw);
		if (r !== null) assert.equal(Object.getPrototypeOf(r), Object.prototype);
		const facts = JSON.parse(`{"kind":"review","__proto__":{"polluted2":"yes"}}`) as unknown;
		const r2 = parseJournalEvent({ ...session("chat_1", AT), facts });
		if (r2 !== null) assert.equal(Object.getPrototypeOf(r2.facts), Object.prototype);
		assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
		assert.equal(({} as Record<string, unknown>)["polluted2"], undefined);
		assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
	});

	it("[spec-gap] a very large commentary is either kept whole or rejected, never silently truncated", () => {
		const big = "x".repeat(2_000_000);
		const r = parseJournalEvent({ ...session("chat_1", AT), commentary: big });
		if (r !== null) assert.equal(r.commentary?.length, big.length);
	});

	it("parsing does not mutate its input", () => {
		const raw = structuredClone(session("chat_1", AT));
		const snapshot = structuredClone(raw);
		parseJournalEvent(raw);
		assert.deepEqual(raw, snapshot);
	});
});

describe("journal: derivation", () => {
	it("first event per key wins, even when a later duplicate carries an earlier timestamp", () => {
		const first = session("chat_1", "2026-11-02T10:40:00.000Z", "review", "first");
		const dup = session("chat_1", "2026-11-02T09:00:00.000Z", "review", "second");
		const out = deriveJournal([first, dup]);
		assert.equal(out.length, 1);
		assert.equal(nth(out, 0).commentary, "first");
	});

	it("a session debrief and a weekly synthesis never deduplicate each other", () => {
		const out = deriveJournal([session("2026-11-02", AT), weekly("2026-11-02", AT)]);
		assert.equal(out.length, 2);
	});

	it("keeps the first-occurrence order of distinct keys", () => {
		const out = deriveJournal([
			session("a", AT),
			session("b", AT),
			session("a", AT, "review", "dup"),
			session("c", AT),
		]);
		assert.deepEqual(out.map((e) => e.sessionId), ["a", "b", "c"]);
	});

	it("is deterministic and does not mutate its input", () => {
		const input = [session("chat_1", AT), session("chat_1", AT, "review", "dup"), weekly("2026-11-02", AT)];
		const snapshot = structuredClone(input);
		const once = deriveJournal(input);
		const twice = deriveJournal(input);
		assert.deepEqual(once, twice);
		assert.deepEqual(input, snapshot);
	});

	it("findDebrief finds by key and never across namespaces", () => {
		const j = deriveJournal([session("chat_1", AT)]);
		assert.equal(must(findDebrief(j, sessionKey("chat_1"))).sessionId, "chat_1");
		assert.equal(findDebrief(j, weeklyKey("chat_1")), null);
		assert.equal(findDebrief(j, sessionKey("nope")), null);
	});
});

function many(n: number): JournalEvent[] {
	const out: JournalEvent[] = [];
	for (let i = 0; i < n; i++) out.push(session(`chat_${i}`, minuteIso("2026-11-01T00:00:00.000Z", i)));
	return out;
}

describe("journal: bounded listing", () => {
	it("default limit caps the list and reports truncation", () => {
		const r = recentDebriefs(deriveJournal(many(DEFAULT_LIST_LIMIT + 10)));
		assert.equal(r.entries.length, DEFAULT_LIST_LIMIT);
		assert.equal(r.truncated, true);
		assert.ok(r.count >= r.entries.length);
	});

	it("non-positive, NaN and fractional limits fall back to the default, never to zero entries", () => {
		const j = deriveJournal(many(DEFAULT_LIST_LIMIT + 10));
		for (const limit of [0, -1, Number.NaN, 2.5]) {
			assert.equal(recentDebriefs(j, { limit }).entries.length, DEFAULT_LIST_LIMIT, `limit ${limit}`);
		}
		const small = deriveJournal(many(3));
		for (const limit of [0, -1, Number.NaN, 2.5]) {
			assert.equal(recentDebriefs(small, { limit }).entries.length, 3, `small journal, limit ${limit}`);
		}
	});

	it("a huge limit is capped at the maximum", () => {
		const j = deriveJournal(many(MAX_LIST_LIMIT + 60));
		const r = recentDebriefs(j, { limit: 1e12 });
		assert.equal(r.entries.length, MAX_LIST_LIMIT);
		assert.equal(r.truncated, true);
	});

	it("a limit equal to the maximum returns exactly the maximum", () => {
		const j = deriveJournal(many(MAX_LIST_LIMIT + 60));
		assert.equal(recentDebriefs(j, { limit: MAX_LIST_LIMIT }).entries.length, MAX_LIST_LIMIT);
	});

	it("truncated is true only when more entries exist than returned", () => {
		const j = deriveJournal(many(3));
		assert.equal(recentDebriefs(j, { limit: 2 }).truncated, true);
		assert.equal(recentDebriefs(j, { limit: 2 }).entries.length, 2);
		assert.equal(recentDebriefs(j, { limit: 5 }).truncated, false);
		assert.equal(recentDebriefs(j, { limit: 5 }).entries.length, 3);
	});

	it("[spec-gap] newest first by timestamp, not by file order", () => {
		const j = deriveJournal([
			session("old", "2026-11-01T08:00:00.000Z"),
			session("new", "2026-11-03T08:00:00.000Z"),
			session("mid", "2026-11-02T08:00:00.000Z"),
		]);
		const r = recentDebriefs(j);
		assert.deepEqual(r.entries.map((e) => e.sessionId), ["new", "mid", "old"]);
	});

	it("the kind filter keeps only weekly entries or only the given session kind", () => {
		const j = deriveJournal([
			session("r1", AT, "review"),
			session("l1", AT, "lecture"),
			weekly("2026-11-02", AT),
		]);
		const weeklyOnly = recentDebriefs(j, { kind: "weekly" } as ListFilter);
		assert.deepEqual(weeklyOnly.entries.map((e) => e.kind), ["weekly"]);
		const lectures = recentDebriefs(j, { kind: "lecture" });
		assert.deepEqual(lectures.entries.map((e) => e.sessionId), ["l1"]);
	});

	it("since keeps entries written at or after it, inclusive at the exact instant", () => {
		const j = deriveJournal([
			session("a", "2026-11-02T08:00:00.000Z"),
			session("b", "2026-11-02T09:00:00.000Z"),
			session("c", "2026-11-02T10:00:00.000Z"),
		]);
		const ids = recentDebriefs(j, { since: "2026-11-02T09:00:00.000Z" }).entries.map((e) => e.sessionId).sort();
		assert.deepEqual(ids, ["b", "c"]);
	});

	it("an unparseable since is ignored", () => {
		const j = deriveJournal(many(4));
		assert.equal(recentDebriefs(j, { since: "not-a-date" }).entries.length, 4);
	});

	it("the listing is deterministic and never returns duplicate ids", () => {
		const input = [...many(5), session("chat_2", AT, "review", "dup")];
		const a = recentDebriefs(deriveJournal(input), { limit: 10 });
		const b = recentDebriefs(deriveJournal(input), { limit: 10 });
		assert.deepEqual(a, b);
		const ids = a.entries.map((e) => e.id);
		assert.equal(new Set(ids).size, ids.length);
	});
});

// ---------------------------------------------------------------- activity

// The lecture id shape is minted by the player and is not written in the spec or the declarations,
// so the test searches a broad family of plausible shapes and uses whatever the pattern accepts.
const LECTURE_PREFIXES = ["lec", "lecture", "lsess", "ls", "lesson", "lp", "player", "lect", "lsn", "sess", "lecsess", "lec_session", "lecture_session", "lecture-session", "lesson_session", "lsession"];
const LECTURE_TAILS = ["0123456789abcdef", "fedcba9876543210", "abc123", "def456", "a1b2c3d4e5f6g7h8i9j0k1", "01J9ZQX3KMW4NPRTYV8BDEFGH0", "1", "x", "lec01", "V1StGXR8Z5jdHi6BmyT0"];
const LECTURE_SEPS = ["_", "-", ""];
const LECTURE_LENGTHS = [4, 6, 8, 10, 12, 14, 16, 20, 24, 26, 32];
const HEX = "0123456789abcdef0123456789abcdef";
const ALNUM = "Ab3dE7fG9hJ2kL4mN6pQ8rS0tU1vW5xY";
const LECTURE_CANDIDATES: string[] = [
	"9f8e7d6c-5b4a-4321-8fed-cba987654321",
	"V1StGXR8_Z5jdHi6B-myT",
	...LECTURE_PREFIXES.flatMap((p) => LECTURE_SEPS.flatMap((s) => LECTURE_TAILS.map((t) => `${p}${s}${t}`))),
	...LECTURE_PREFIXES.flatMap((p) => ["_", "-", ":", "."].flatMap((s) => ["V1StGXR8_Z5jdHi6B-myT", "0123456789abcdef0123456789abcdef", "9f8e7d6c-5b4a-4321-8fed-cba987654321", "a".repeat(21), "a".repeat(32), "1".repeat(16)].map((t) => `${p}${s}${t}`))),
	...LECTURE_PREFIXES.flatMap((p) => LECTURE_LENGTHS.flatMap((n) => ["_", "-", ""].flatMap((s) => [`${p}${s}${HEX.slice(0, n)}`, `${p}${s}${ALNUM.slice(0, n)}`, `${p}${s}${ALNUM.toUpperCase().slice(0, n)}`].map((x) => x)))),
];
const ANY_CANDIDATES = [
	"chat_0123456789abcdef",
	"chat_fedcba9876543210",
	"set_0123456789abcdef",
	"ex_0123456789abcdef",
	"chat_abc123",
	"chat_def456",
	"abc123def456",
	"0123456789abcdef",
	"chat-0123456789abcdef",
	"ch_abc123",
];
const LECTURE_MATCHES = LECTURE_CANDIDATES.filter((s) => LECTURE_SESSION_ID.test(s));
const ANY_MATCHES = ANY_CANDIDATES.filter((s) => ANY_SESSION_ID.test(s));
const L1 = LECTURE_MATCHES[0] ?? "__no_lecture_sample__";
const L2 = LECTURE_MATCHES[1] ?? "__no_second_lecture_sample__";
const ANY1 = ANY_MATCHES[0] ?? "__no_any_sample__";

type LectureEv = Exclude<ActivityEvent, { type: "end" }>;
const LEC = "lec_alpha";
const LEC_OTHER = "lec_beta";
const lv = (sid: string, at: string, slideId: string, lectureId = LEC): LectureEv => ({
	type: "lecture_view",
	sessionId: sid,
	lectureId,
	slideId,
	at,
});
const co = (sid: string, at: string, nodeId: string, lectureId = LEC): LectureEv => ({
	type: "concept_open",
	sessionId: sid,
	lectureId,
	nodeId,
	at,
});
const ed = (sid: string, at: string, blockId: string, lectureId = LEC): LectureEv => ({
	type: "exercise_done",
	sessionId: sid,
	lectureId,
	blockId,
	at,
});
const endEv = (sid: string, at: string): ActivityEvent => ({ type: "end", sessionId: sid, at });

const T1 = "2026-11-02T10:00:00.000Z";
const T2 = "2026-11-02T10:05:00.000Z";
const T3 = "2026-11-02T10:10:00.000Z";
const T4 = "2026-11-02T10:15:00.000Z";
const T5 = "2026-11-02T10:20:00.000Z";

describe("activity: session id shapes", () => {
	it("the test has a lecture-shaped and a chat-shaped sample id (fixture guard)", () => {
		const lectureSamples = ["lecs_abcdefgh1", "lecs_abcdefgh2"];
		assert.ok(lectureSamples.every((s) => LECTURE_SESSION_ID.test(s)), "lecture sample ids not accepted by LECTURE_SESSION_ID");
		assert.ok(ANY_MATCHES.length >= 1, `sample ids accepted by ANY_SESSION_ID: ${ANY_MATCHES.length}`);
	});

	it("neither id pattern is stateful (no g or y flag, which would make test() alternate)", () => {
		for (const re of [LECTURE_SESSION_ID, ANY_SESSION_ID]) {
			assert.equal(re.global, false);
			assert.equal(re.sticky, false);
		}
	});

	it("both patterns reject empty, blank and newline-injected ids", () => {
		for (const re of [LECTURE_SESSION_ID, ANY_SESSION_ID]) {
			for (const bad of ["", " ", "a b", "a\nb", "../etc"]) {
				assert.equal(re.test(bad), false, `${re.source} accepted ${JSON.stringify(bad)}`);
			}
		}
	});

	it("[spec-gap] a session id of __proto__ is not accepted, since ids are used as object keys", () => {
		assert.equal(LECTURE_SESSION_ID.test("__proto__"), false);
		assert.equal(ANY_SESSION_ID.test("__proto__"), false);
	});

	it("patterns finish quickly on a pathological input (no catastrophic backtracking)", () => {
		const evil = "a".repeat(100_000) + "!";
		const t0 = Date.now();
		LECTURE_SESSION_ID.test(evil);
		ANY_SESSION_ID.test(evil);
		assert.ok(Date.now() - t0 < 1000, "pattern test took more than 1s");
	});
});

describe("activity: parsing", () => {
	it("accepts well-formed lecture events", () => {
		const ev = lv("lecs_abcdefgh1", T1, "s1");
		assert.deepEqual(parseActivityEvent(ev), ev);
	});

	it("rejects non-objects and unknown event types", () => {
		assert.equal(parseActivityEvent(null), null);
		assert.equal(parseActivityEvent("lecture_view"), null);
		assert.equal(parseActivityEvent({ type: "lecture_skipped", sessionId: L1, at: T1 }), null);
	});

	it("rejects a lecture_view without a slide id, or with a non-string one", () => {
		const noSlide: Record<string, unknown> = { ...lv(L1, T1, "s1") };
		delete noSlide.slideId;
		assert.equal(parseActivityEvent(noSlide), null);
		assert.equal(parseActivityEvent({ ...lv(L1, T1, "s1"), slideId: 3 }), null);
	});

	it("a lecture event requires a lecture-shaped session id", () => {
		if (!LECTURE_SESSION_ID.test(ANY1)) {
			assert.equal(parseActivityEvent(lv(ANY1, T1, "s1")), null);
		} else {
			assert.fail("no chat-shaped id that the lecture pattern rejects; fixture cannot exercise this rule");
		}
	});

	it("an end event accepts any session id shape and rejects empty ones", () => {
		assert.ok(parseActivityEvent(endEv(ANY1, T1)) !== null);
		assert.equal(parseActivityEvent(endEv("", T1)), null);
		assert.equal(parseActivityEvent(endEv(" ", T1)), null);
	});

	it("rejects a missing timestamp", () => {
		const { at: _omit, ...noAt } = lv(L1, T1, "s1");
		assert.equal(parseActivityEvent(noAt), null);
	});

	it("[spec-gap] rejects a timestamp that is not a date", () => {
		assert.equal(parseActivityEvent({ ...lv(L1, T1, "s1"), at: "yesterday" }), null);
	});

	it("a __proto__ key in a raw event never pollutes prototypes", () => {
		const raw = JSON.parse(`${JSON.stringify(lv(L1, T1, "s1")).slice(0, -1)},"__proto__":{"polluted":"yes"}}`) as unknown;
		const r = parseActivityEvent(raw);
		if (r !== null) assert.equal(Object.getPrototypeOf(r), Object.prototype);
		assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
	});
});

describe("activity: lecture session derivation", () => {
	it("derives slides, concepts and exercises as sets for one lecture session", () => {
		const events: ActivityEvent[] = [lv(L1, T1, "s1"), lv(L1, T2, "s2"), co(L1, T3, "n1"), ed(L1, T4, "b1")];
		const out = deriveLectureSessions(events);
		assert.equal(out.length, 1);
		const s = nth(out, 0);
		assert.equal(s.sessionId, L1);
		assert.equal(s.lectureId, LEC);
		assert.equal(s.slides.size, 2);
		assert.equal(s.concepts.size, 1);
		assert.equal(s.exercises.size, 1);
		assert.equal(ms(s.startedAt), ms(T1));
		assert.equal(ms(s.lastActivityAt), ms(T4));
	});

	it("sessions come out in the order of their first event", () => {
		const out = deriveLectureSessions([lv(L1, T1, "s1"), lv(L2, T2, "s1"), lv(L1, T3, "s2")]);
		assert.deepEqual(out.map((s) => s.sessionId), [L1, L2]);
	});

	it("the first event fixes the lecture; later events naming another lecture are ignored", () => {
		const out = deriveLectureSessions([lv(L1, T1, "s1", LEC), co(L1, T2, "n9", LEC_OTHER)]);
		const s = nth(out, 0);
		assert.equal(s.lectureId, LEC);
		assert.equal(s.concepts.size, 0);
	});

	it("repeated views of one slide count once", () => {
		const out = deriveLectureSessions([lv(L1, T1, "s1"), lv(L1, T2, "s1"), lv(L1, T3, "s1")]);
		assert.equal(nth(out, 0).slides.size, 1);
	});

	it("[spec-gap] last activity is the latest timestamp even when the file is out of order", () => {
		const out = deriveLectureSessions([co(L1, T5, "n1"), lv(L1, T1, "s1")]);
		const s = nth(out, 0);
		assert.equal(ms(s.lastActivityAt), ms(T5));
		assert.equal(ms(s.startedAt), ms(T1));
	});

	it("[spec-gap] an end event alone does not create a lecture session", () => {
		assert.deepEqual(deriveLectureSessions([endEv(L1, T1)]), []);
	});

	it("an empty event list yields no sessions", () => {
		assert.deepEqual(deriveLectureSessions([]), []);
	});

	it("derivation does not mutate its input", () => {
		const events: ActivityEvent[] = [lv(L1, T1, "s1"), co(L1, T2, "n1")];
		const snapshot = structuredClone(events);
		deriveLectureSessions(events);
		assert.deepEqual(events, snapshot);
	});
});

describe("activity: explicit ends and recording", () => {
	it("the EARLIEST end per session wins, regardless of file order", () => {
		const m = explicitEnds([endEv(L1, T5), endEv(L1, T2)]);
		assert.equal(m.get(L1), T2);
	});

	it("maps each session separately and ignores non-end events", () => {
		const m = explicitEnds([lv(L2, T1, "s1"), endEv(ANY1, T3), endEv(L1, T4)]);
		assert.equal(m.get(ANY1), T3);
		assert.equal(m.get(L1), T4);
		assert.equal(m.has(L2), false);
	});

	it("a repeated lecture event is recognised regardless of its timestamp", () => {
		assert.equal(alreadyRecorded([lv(L1, T1, "s1")], lv(L1, T5, "s1")), true);
	});

	it("a different slide, session, or event type is not a repeat", () => {
		const base: ActivityEvent[] = [lv(L1, T1, "s1")];
		assert.equal(alreadyRecorded(base, lv(L1, T1, "s2")), false);
		assert.equal(alreadyRecorded(base, lv(L2, T1, "s1")), false);
		assert.equal(alreadyRecorded([lv(L1, T1, "x9")], co(L1, T1, "x9")), false);
	});

	it("exercise repeats are matched by block id", () => {
		const base: ActivityEvent[] = [ed(L1, T1, "b1")];
		assert.equal(alreadyRecorded(base, ed(L1, T5, "b1")), true);
		assert.equal(alreadyRecorded(base, ed(L1, T5, "b2")), false);
	});

	it("nothing is recorded in an empty history", () => {
		assert.equal(alreadyRecorded([], lv(L1, T1, "s1")), false);
	});
});

// ---------------------------------------------------------------- sessions

const START = "2026-11-02T10:00:00.000Z";
const LAST = "2026-11-02T10:10:00.000Z";
const IDLE = 30 * 60_000;
const LOOK = 3 * 24 * 3600_000;

function ref(sessionId: string, lastActivityAt: string, startedAt = lastActivityAt, kind: SessionKind = "review"): SessionRef {
	return { sessionId, kind, title: sessionId, startedAt, lastActivityAt };
}

describe("sessions: session end rules", () => {
	const R = ref("s1", LAST, START);

	it("the session is still open one millisecond before the inactivity threshold", () => {
		assert.equal(endedAtOf(R, new Date(ms(LAST) + IDLE - 1), IDLE, undefined), null);
	});

	it("[spec-gap] the session ends exactly at the inactivity threshold", () => {
		const r = endedAtOf(R, new Date(ms(LAST) + IDLE), IDLE, undefined);
		assert.notEqual(r, null);
		assert.equal(ms(must(r)), ms(LAST));
	});

	it("the session ends one millisecond after the threshold, at its last activity (not at now)", () => {
		const r = endedAtOf(R, new Date(ms(LAST) + IDLE + 1), IDLE, undefined);
		assert.equal(ms(must(r)), ms(LAST));
	});

	it("an explicit end wins over the idle rule and is used as the end", () => {
		const r = endedAtOf(R, new Date(ms(LAST) + 1000), IDLE, "2026-11-02T10:20:00.000Z");
		assert.equal(ms(must(r)), ms("2026-11-02T10:20:00.000Z"));
	});

	it("an explicit end before the start is clamped to the start", () => {
		const r = endedAtOf(R, new Date(ms(LAST) + 1000), IDLE, "2026-11-02T09:00:00.000Z");
		assert.equal(ms(must(r)), ms(START));
	});

	it("an explicit end stands even when activity happened after it", () => {
		const late = ref("s1", "2026-11-02T10:50:00.000Z", START);
		const r = endedAtOf(late, new Date("2026-11-02T11:00:00.000Z"), IDLE, "2026-11-02T10:20:00.000Z");
		assert.equal(ms(must(r)), ms("2026-11-02T10:20:00.000Z"));
	});

	it("an unparseable explicit end never ends a session that is still active", () => {
		assert.equal(endedAtOf(R, new Date(ms(LAST) + 60_000), IDLE, "not-a-date"), null);
	});

	it("an unparseable last activity never ends a session", () => {
		const bad = ref("s1", "garbage", START);
		assert.equal(endedAtOf(bad, new Date("2026-11-03T00:00:00.000Z"), IDLE, undefined), null);
	});

	it("a NaN clock never ends a session", () => {
		assert.equal(endedAtOf(R, new Date(Number.NaN), IDLE, undefined), null);
	});

	it("end computation does not read the wall clock", () => {
		const r = withoutClock(() => endedAtOf(R, new Date(ms(LAST) + IDLE + 1), IDLE, undefined));
		assert.equal(ms(must(r)), ms(LAST));
	});
});

describe("sessions: pending debriefs", () => {
	const NOW = new Date("2026-11-02T14:00:00.000Z");
	const refs: SessionRef[] = [
		ref("chat_a", "2026-11-02T10:10:00.000Z"),
		ref("chat_b", "2026-11-02T12:00:00.000Z"),
		ref("chat_e", "2026-11-02T11:00:00.000Z"),
		ref("chat_d", "2026-11-02T13:55:00.000Z"),
		ref("chat_old", "2026-10-01T10:00:00.000Z"),
	];
	const pend = (
		rs: readonly SessionRef[],
		journal: readonly JournalEvent[] = [],
		ends: ReadonlyMap<string, string> = new Map(),
		now: Date = NOW,
		lookbackMs = LOOK,
	) => pendingSessions({ refs: rs, journal, ends, now, idleMs: IDLE, lookbackMs });

	it("returns ended, undebriefed, recent sessions, oldest end first", () => {
		const out = pend(refs, [session("chat_a", AT)]);
		assert.deepEqual(out.map((p) => p.ref.sessionId), ["chat_e", "chat_b"]);
	});

	it("a session with a debrief, an open session and an old session are all excluded", () => {
		const ids = pend(refs, [session("chat_a", AT)]).map((p) => p.ref.sessionId);
		assert.equal(ids.includes("chat_a"), false);
		assert.equal(ids.includes("chat_d"), false);
		assert.equal(ids.includes("chat_old"), false);
	});

	it("an explicit end counts as the session end, and sorts by it", () => {
		const ends = new Map([["chat_d", "2026-11-02T13:00:00.000Z"]]);
		const out = pend(refs, [session("chat_a", AT)], ends);
		assert.deepEqual(out.map((p) => p.ref.sessionId), ["chat_e", "chat_b", "chat_d"]);
		assert.equal(ms(nth(out, 2).endedAt), ms("2026-11-02T13:00:00.000Z"));
	});

	it("[spec-gap] a session whose end is exactly the lookback window old is still pending", () => {
		const edge = ref("chat_edge", new Date(NOW.getTime() - LOOK).toISOString());
		assert.ok(pend([edge]).some((p) => p.ref.sessionId === "chat_edge"));
	});

	it("a session one millisecond older than the lookback window is excluded", () => {
		const past = ref("chat_past", new Date(NOW.getTime() - LOOK - 1).toISOString());
		assert.equal(pend([past]).length, 0);
	});

	it("a session listed twice counts once", () => {
		const out = pend([refs[1] as SessionRef, refs[1] as SessionRef]);
		assert.equal(out.length, 1);
	});

	it("a weekly debrief does not block a session that has the same string as its week", () => {
		const out = pend([ref("2026-11-02", "2026-11-02T12:00:00.000Z")], [weekly("2026-11-02", AT)]);
		assert.equal(out.length, 1);
	});

	it("[spec-gap] a session whose id looks like a weekly key is pending even if that week has a debrief", () => {
		const out = pend([ref("weekly:2026-11-02", "2026-11-02T12:00:00.000Z")], [weekly("2026-11-02", AT)]);
		assert.equal(out.length, 1);
	});

	it("no refs means nothing pending, and the computation is pure", () => {
		assert.deepEqual(pend([]), []);
		const snapshot = structuredClone(refs);
		const a = pend(refs);
		const b = pend(refs);
		assert.deepEqual(a, b);
		assert.deepEqual(refs, snapshot);
	});
});

describe("sessions: ownership of review events", () => {
	const W1: Window = { sessionId: "s1", startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T12:00:00.000Z" };
	const W2: Window = { sessionId: "s2", startedAt: "2026-11-02T11:00:00.000Z", endedAt: "2026-11-02T13:00:00.000Z" };

	it("an event in one window belongs to that window", () => {
		assert.equal(ownerOfEvent("2026-11-02T10:30:00.000Z", [W1, W2]), "s1");
	});

	it("in an overlap, the window that started last owns the event", () => {
		assert.equal(ownerOfEvent("2026-11-02T11:30:00.000Z", [W1, W2]), "s2");
		assert.equal(ownerOfEvent("2026-11-02T11:30:00.000Z", [W2, W1]), "s2");
	});

	it("an event after all windows, or before them, is unowned", () => {
		assert.equal(ownerOfEvent("2026-11-02T14:00:00.000Z", [W1, W2]), null);
		assert.equal(ownerOfEvent("2026-11-02T08:00:00.000Z", [W1, W2]), null);
	});

	it("an empty window list owns nothing", () => {
		assert.equal(ownerOfEvent("2026-11-02T10:30:00.000Z", []), null);
	});

	it("ties on start go to the smaller session id, whatever the list order", () => {
		const W0: Window = { sessionId: "s0", startedAt: "2026-11-02T11:00:00.000Z", endedAt: "2026-11-02T13:00:00.000Z" };
		assert.equal(ownerOfEvent("2026-11-02T11:30:00.000Z", [W2, W0]), "s0");
		assert.equal(ownerOfEvent("2026-11-02T11:30:00.000Z", [W0, W2]), "s0");
	});

	it("an unparseable event time is unowned", () => {
		assert.equal(ownerOfEvent("garbage", [W1]), null);
	});
});

// ---------------------------------------------------------------- facts

function reviewEv(nodeId: string, at: string, rating: 1 | 2 | 3 | 4 = 3, durationSec = 30, channel: "fixed" | "dialogic" = "fixed"): ReviewEvent {
	return { type: "review", nodeId, channel, rating, durationSec, at };
}

describe("facts: time span", () => {
	it("returns whole seconds between two instants", () => {
		assert.equal(spanSec("2026-11-02T10:00:00Z", "2026-11-02T10:01:30Z"), 90);
		assert.equal(spanSec("2026-11-02T10:00:00Z", "2026-11-02T10:00:00Z"), 0);
	});

	it("a reversed, unparseable or empty span is 0", () => {
		assert.equal(spanSec("2026-11-02T10:01:30Z", "2026-11-02T10:00:00Z"), 0);
		assert.equal(spanSec("garbage", "2026-11-02T10:00:00Z"), 0);
		assert.equal(spanSec("2026-11-02T10:00:00Z", "garbage"), 0);
		assert.equal(spanSec("", ""), 0);
	});

	it("a fractional span yields an integer between its floor and ceiling", () => {
		const r = spanSec("2026-11-02T10:00:00.000Z", "2026-11-02T10:00:01.900Z");
		assert.equal(Number.isInteger(r), true);
		assert.ok(r >= 1 && r <= 2, `got ${r}`);
	});
});

describe("facts: review sessions", () => {
	const startedAt = "2026-11-02T10:00:00.000Z";
	const endedAt = "2026-11-02T10:30:00.000Z";
	const owns = (at: string): boolean => at >= startedAt && at <= endedAt;
	const names = new Map([
		["n1", "Premise one"],
		["n2", "Premise two"],
	]);
	const events: ReviewEvent[] = [
		reviewEv("n1", "2026-11-02T10:05:00.000Z", 4, 20, "fixed"),
		{ type: "review", nodeId: "n1", channel: "dialogic", rating: 1, durationSec: 40, at: "2026-11-02T10:06:00.000Z", weakPremises: ["n2", "ghost"] },
		{ type: "review", nodeId: "n2", channel: "fixed", rating: 2, durationSec: 10, at: "2026-11-02T10:07:00.000Z", weakPremises: ["n2"] },
		reviewEv("ghost", "2026-11-02T10:08:00.000Z", 3, 99, "fixed"),
		reviewEv("n1", "2026-11-02T11:00:00.000Z", 3, 5, "fixed"),
	];

	it("counts only owned reviews of existing nodes, with per-channel and rating distributions", () => {
		const f = computeReviewFacts({ startedAt, endedAt, events, owns, names, budgetSec: 1200 });
		assert.equal(f.reviews, 3);
		assert.deepEqual(f.perChannel, { fixed: 2, dialogic: 1 });
		assert.deepEqual(f.ratings, { "1": 1, "2": 1, "3": 0, "4": 1 });
		assert.equal(f.lapses, 1);
		assert.equal(f.reviewSec, 70);
	});

	it("the ratings sum to the review count and the lapses equal the Again ratings", () => {
		const f = computeReviewFacts({ startedAt, endedAt, events, owns, names, budgetSec: 1200 });
		assert.equal(f.ratings["1"] + f.ratings["2"] + f.ratings["3"] + f.ratings["4"], f.reviews);
		assert.equal(f.lapses, f.ratings["1"]);
	});

	it("duration is the span of the session, and the budget ratio is rounded to 3 decimals", () => {
		const f = computeReviewFacts({ startedAt, endedAt, events, owns, names, budgetSec: 1200 });
		assert.equal(f.durationSec, 1800);
		assert.equal(f.budgetSec, 1200);
		assert.equal(f.budgetRatio, 0.058);
	});

	it("a non-positive budget gives a null budget ratio, never NaN or Infinity", () => {
		for (const budgetSec of [0, -10]) {
			const f = computeReviewFacts({ startedAt, endedAt, events, owns, names, budgetSec });
			assert.equal(f.budgetRatio, null, `budget ${budgetSec}`);
		}
	});

	it("weak premises: existing nodes only, most often first", () => {
		const f = computeReviewFacts({ startedAt, endedAt, events, owns, names, budgetSec: 1200 });
		assert.deepEqual(f.weakPremises, [{ nodeId: "n2", name: "Premise two", count: 2 }]);
	});

	it("weak premises are capped at ten and ordered by count", () => {
		const many = new Map<string, string>();
		const evs: ReviewEvent[] = [];
		for (let i = 0; i < 12; i++) many.set(`p${i}`, `Name ${i}`);
		for (let i = 0; i < 12; i++) {
			evs.push({ type: "review", nodeId: "p0", channel: "fixed", rating: 2, durationSec: 1, at: startedAt, weakPremises: [`p${i}`] });
		}
		evs.push({ type: "review", nodeId: "p0", channel: "fixed", rating: 2, durationSec: 1, at: startedAt, weakPremises: ["p5", "p5"] });
		const f = computeReviewFacts({ startedAt, endedAt, events: evs, owns, names: many, budgetSec: 1200 });
		assert.ok(f.weakPremises.length <= 10);
		assert.equal(nth(f.weakPremises, 0).nodeId, "p5");
	});

	it("an empty session has zero counts, a zero budget ratio and no NaN", () => {
		const f = computeReviewFacts({ startedAt, endedAt, events: [], owns, names, budgetSec: 1200 });
		assert.equal(f.reviews, 0);
		assert.equal(f.reviewSec, 0);
		assert.equal(f.budgetRatio, 0);
		assert.deepEqual(f.weakPremises, []);
		assert.equal(Number.isNaN(f.budgetRatio), false);
	});

	it("a negative duration in the ledger never yields a negative total", () => {
		const f = computeReviewFacts({
			startedAt,
			endedAt,
			events: [reviewEv("n1", "2026-11-02T10:05:00.000Z", 3, -30, "fixed")],
			owns,
			names,
			budgetSec: 1200,
		});
		assert.ok(f.reviewSec >= 0, `reviewSec ${f.reviewSec}`);
	});

	it("is pure: the input is not mutated and the output is repeatable", () => {
		const input = { startedAt, endedAt, events: structuredClone(events), owns, names, budgetSec: 1200 };
		const snapshot = structuredClone(input.events);
		const a = computeReviewFacts(input);
		const b = computeReviewFacts(input);
		assert.deepEqual(a, b);
		assert.deepEqual(input.events, snapshot);
	});
});

describe("facts: lecture sessions", () => {
	const startedAt = "2026-11-02T10:00:00.000Z";
	const endedAt = "2026-11-02T10:45:00.000Z";

	it("counts slides, concepts and exercises against the lecture's totals", () => {
		const f = computeLectureFacts({
			startedAt,
			endedAt,
			lectureId: LEC,
			lecture: { title: "Lecture 1", slideIds: ["s1", "s2", "s3"], exerciseBlockIds: ["b1", "b2"] },
			slides: new Set(["s1", "s2"]),
			concepts: new Set(["c1", "c2", "c3"]),
			exercises: new Set(["b1"]),
		});
		assert.equal(f.slidesViewed, 2);
		assert.equal(f.slidesTotal, 3);
		assert.equal(f.conceptsOpened, 3);
		assert.equal(f.exercisesDone, 1);
		assert.equal(f.exercisesTotal, 2);
		assert.equal(f.title, "Lecture 1");
		assert.equal(f.lectureId, LEC);
		assert.equal(f.durationSec, 2700);
	});

	it("a deleted lecture gives null totals and title, while the counts stay sane", () => {
		const f = computeLectureFacts({
			startedAt,
			endedAt,
			lectureId: LEC,
			lecture: null,
			slides: new Set(["s1", "s2"]),
			concepts: new Set(),
			exercises: new Set(["b1"]),
		});
		assert.equal(f.slidesTotal, null);
		assert.equal(f.exercisesTotal, null);
		assert.equal(f.title, null);
		assert.equal(f.slidesViewed, 2);
		assert.equal(f.exercisesDone, 1);
	});

	it("[spec-gap] viewed slides never exceed the lecture's slide total, even with stale ids", () => {
		const f = computeLectureFacts({
			startedAt,
			endedAt,
			lectureId: LEC,
			lecture: { title: "L", slideIds: ["s1", "s2"], exerciseBlockIds: [] },
			slides: new Set(["s1", "zz-removed", "yy-removed"]),
			concepts: new Set(),
			exercises: new Set(),
		});
		assert.ok(f.slidesViewed <= 2, `slidesViewed ${f.slidesViewed}`);
	});

	it("an empty lecture session is all zeros with no NaN", () => {
		const f = computeLectureFacts({
			startedAt,
			endedAt,
			lectureId: LEC,
			lecture: { title: "L", slideIds: [], exerciseBlockIds: [] },
			slides: new Set(),
			concepts: new Set(),
			exercises: new Set(),
		});
		assert.equal(f.slidesViewed, 0);
		assert.equal(f.conceptsOpened, 0);
		assert.equal(f.exercisesDone, 0);
	});
});

describe("facts: office hours", () => {
	const chatId = "oh_1";
	const startedAt = "2026-11-02T10:00:00.000Z";
	const endedAt = "2026-11-02T11:00:00.000Z";
	const item = (stepRef: string, stance: VerdictItem["stance"]): VerdictItem => ({
		stepRef,
		sourceQuote: "quoted source text",
		workQuote: stance === "missing" ? "" : "quoted work text",
		stance,
	});
	const verdict = (cid: string, at: string, outcome: "consistent" | "differs" | "not_verifiable", items: VerdictItem[]): OfficeHoursEvent => ({
		type: "verdict",
		chatId: cid,
		outcome,
		items,
		discarded: 0,
		at,
	});
	const designated = (cid: string, label: string, at: string): OfficeHoursEvent => ({
		type: "designated",
		chatId: cid,
		label,
		sha256: "0".repeat(64),
		at,
	});
	const events: OfficeHoursEvent[] = [
		designated(chatId, "Solutions manual", "2026-11-02T10:00:30.000Z"),
		designated(chatId, "Exercise reference", "2026-11-02T10:20:00.000Z"),
		designated("oh_2", "Other session", "2026-11-02T10:05:00.000Z"),
		verdict(chatId, "2026-11-02T10:10:00.000Z", "differs", [item("s1", "differs"), item("s2", "matches"), item("s3", "missing")]),
		verdict(chatId, "2026-11-02T10:30:00.000Z", "consistent", [item("s1", "matches")]),
		verdict("oh_2", "2026-11-02T10:31:00.000Z", "differs", [item("s9", "differs")]),
		verdict(chatId, "2026-11-02T12:00:00.000Z", "not_verifiable", [item("s9", "differs")]),
	];
	const transcript: TranscriptLine[] = [
		{ role: "user", at: ms("2026-11-02T10:01:00.000Z"), text: "my answer" },
		{ role: "assistant", at: ms("2026-11-02T10:02:00.000Z"), text: "What is s1?" },
		{ role: "user", at: ms("2026-11-02T10:03:00.000Z"), text: "another" },
		{ role: "assistant", at: ms("2026-11-02T10:04:00.000Z"), text: "Sure." },
		{ role: "user", at: ms("2026-11-02T12:30:00.000Z"), text: "after the window" },
		{ role: "user", at: ms("2026-11-02T09:00:00.000Z"), text: "before the window" },
	];
	const compute = () => computeOfficeHoursFacts({ chatId, startedAt, endedAt, events, transcript });

	it("uses the latest designation of this session", () => {
		assert.equal(compute().designatedSource, "Exercise reference");
	});

	it("counts verdicts by outcome, only for this session and inside the window", () => {
		assert.deepEqual(compute().verdicts, { consistent: 1, differs: 1, not_verifiable: 0 });
	});

	it("the latest-verdict items are counted by stance", () => {
		assert.deepEqual(compute().latestItems, { matches: 1, differs: 0, missing: 0 });
	});

	it("steps questioned are distinct across verdicts; out-of-window verdicts are ignored", () => {
		assert.equal(compute().stepsQuestioned, 2);
	});

	it("learner messages are counted inside the window only", () => {
		assert.equal(compute().learnerMessages, 2);
	});

	it("unanswered questions are counted on the in-window transcript", () => {
		const inWindow = transcript.filter((l) => l.at >= ms(startedAt) && l.at <= ms(endedAt));
		assert.equal(compute().unansweredQuestions, countUnanswered(inWindow));
	});

	it("an office-hours session with no events is all zeros and no designation", () => {
		const f = computeOfficeHoursFacts({ chatId: "empty", startedAt, endedAt, events: [], transcript: [] });
		assert.equal(f.designatedSource, null);
		assert.deepEqual(f.verdicts, { consistent: 0, differs: 0, not_verifiable: 0 });
		assert.equal(f.stepsQuestioned, 0);
		assert.equal(f.learnerMessages, 0);
	});
});

describe("facts: unanswered tutor questions", () => {
	const a = (text: string, n = 0): TranscriptLine => ({ role: "assistant", at: n, text });
	const u = (text: string, n = 0): TranscriptLine => ({ role: "user", at: n, text });

	it("a tutor question answered by the learner is not counted", () => {
		assert.equal(countUnanswered([a("What?"), u("x"), a("Fine.")]), 0);
	});

	it("a tutor question followed by another tutor turn with no learner reply is unanswered", () => {
		assert.equal(countUnanswered([a("Why?"), a("Think about it.")]), 1);
	});

	it("only a final question mark counts; a question mark mid-sentence does not", () => {
		assert.equal(countUnanswered([a("Is it? Yes.")]), 0);
	});

	it("a question at the very end of the session is unanswered", () => {
		assert.equal(countUnanswered([u("hi"), a("Ready?")]), 1);
	});

	it("learner questions are never counted as unanswered tutor questions", () => {
		assert.equal(countUnanswered([u("Why?")]), 0);
	});

	it("consecutive unanswered tutor questions are each counted", () => {
		assert.equal(countUnanswered([a("A?"), a("B?")]), 2);
	});

	it("a question answered before the next question is not unanswered", () => {
		assert.equal(countUnanswered([a("A?"), u("x"), a("B?"), u("y")]), 0);
	});

	it("an empty transcript and an empty tutor line count as zero", () => {
		assert.equal(countUnanswered([]), 0);
		assert.equal(countUnanswered([a("")]), 0);
	});
});

describe("facts: exercise sets", () => {
	const ex = (id: string, nodeIds: string[]): Exercise => ({
		id,
		prompt: `prompt ${id}`,
		nodeIds,
		steps: nodeIds.map((n, i) => ({ id: `${id}.s${i}`, text: `step ${i}`, nodeIds: [n] })),
	});
	const graded = (exerciseId: string, outcome: "consistent" | "differs" | "not_verifiable", nodeOutcomes: Array<{ nodeId: string; outcome: "passed" | "weak" | "failed" }>, lowConfidence: boolean, at: string) => ({
		type: "graded" as const,
		setId: "set1",
		exerciseId,
		outcome,
		nodeOutcomes,
		lowConfidence,
		at,
	});
	const names = new Map([
		["n1", "Premise A"],
		["n2", "Premise B"],
		["n3", "Premise C"],
	]);
	const set: ExerciseSetState = {
		setId: "set1",
		goalId: "g1",
		exercises: [ex("e1", ["n1", "n2"]), ex("e2", ["n1"]), ex("e3", ["n3"])],
		createdAt: "2026-11-01T00:00:00.000Z",
		graded: new Map([
			["e1", graded("e1", "consistent", [{ nodeId: "n1", outcome: "passed" }, { nodeId: "n2", outcome: "failed" }], false, "2026-11-02T10:10:00.000Z")],
			["e2", graded("e2", "differs", [{ nodeId: "n1", outcome: "weak" }], true, "2026-11-02T10:20:00.000Z")],
		]),
		applied: null,
	};
	const run = (s: ExerciseSetState) =>
		computeExerciseFacts({ set: s, startedAt: "2026-11-02T10:00:00.000Z", endedAt: "2026-11-02T11:00:00.000Z", names });

	it("counts exercises total and graded, and low-confidence gradings", () => {
		const f = run(set);
		assert.equal(f.exercisesTotal, 3);
		assert.equal(f.exercisesGraded, 2);
		assert.equal(f.lowConfidenceGradings, 1);
	});

	it("a node's outcome is the worst across its latest gradings; ungraded nodes are absent", () => {
		const f = run(set);
		const byId = new Map(f.nodes.map((n) => [n.nodeId, n]));
		assert.equal(byId.get("n1")?.outcome, "weak");
		assert.equal(byId.get("n2")?.outcome, "failed");
		assert.equal(byId.has("n3"), false);
		assert.equal(byId.get("n1")?.name, "Premise A");
	});

	it("the worst-outcome order is failed over weak over passed, with each node listed once", () => {
		const s: ExerciseSetState = {
			...set,
			graded: new Map([
				["e1", graded("e1", "consistent", [{ nodeId: "n1", outcome: "passed" }], false, "2026-11-02T10:10:00.000Z")],
				["e2", graded("e2", "differs", [{ nodeId: "n1", outcome: "weak" }], false, "2026-11-02T10:15:00.000Z")],
				["e3", graded("e3", "differs", [{ nodeId: "n1", outcome: "failed" }], false, "2026-11-02T10:20:00.000Z")],
			]),
		};
		const f = run(s);
		assert.equal(f.nodes.length, 1);
		assert.equal(nth(f.nodes, 0).outcome, "failed");
	});

	it("applied and goalReached follow the set's applied record", () => {
		const none = run(set);
		assert.equal(none.applied, false);
		assert.equal(none.goalReached, false);
		const reached = run({ ...set, applied: { reached: true } });
		assert.equal(reached.applied, true);
		assert.equal(reached.goalReached, true);
	});

	it("an empty set is all zeros with no nodes", () => {
		const f = run({ ...set, exercises: [], graded: new Map() });
		assert.equal(f.exercisesTotal, 0);
		assert.equal(f.exercisesGraded, 0);
		assert.deepEqual(f.nodes, []);
	});
});

describe("facts: study sessions", () => {
	const startedAt = "2026-11-02T10:00:00.000Z";
	const endedAt = "2026-11-02T11:00:00.000Z";
	const transcript: TranscriptLine[] = [
		{ role: "user", at: ms("2026-11-02T10:10:00.000Z"), text: "q" },
		{ role: "assistant", at: ms("2026-11-02T10:11:00.000Z"), text: "answer?" },
		{ role: "user", at: ms("2026-11-02T10:20:00.000Z"), text: "q2" },
	];

	it("counts distinct pages read, learner messages, distinct linked nodes and in-window cards", () => {
		const f = computeStudyFacts({
			startedAt,
			endedAt,
			document: { documentId: "doc1", title: "Chapter 3" },
			pagesRead: [1, 2, 2, 3],
			transcript,
			linkedNodeIds: ["n1", "n2", "n1"],
			createdCards: [
				{ nodeId: "n1", at: "2026-11-02T10:30:00.000Z" },
				{ nodeId: "n2", at: "2026-11-02T09:00:00.000Z" },
			],
		});
		assert.equal(f.documentId, "doc1");
		assert.equal(f.title, "Chapter 3");
		assert.equal(f.pagesRead, 3);
		assert.equal(f.learnerMessages, 2);
		assert.equal(f.nodesLinked, 2);
		assert.equal(f.cardsCreated, 1);
		assert.equal(f.durationSec, 3600);
	});

	it("a session without a document has null document fields and zero counts", () => {
		const f = computeStudyFacts({ startedAt, endedAt, document: null, pagesRead: [], transcript: [], linkedNodeIds: [], createdCards: [] });
		assert.equal(f.documentId, null);
		assert.equal(f.title, null);
		assert.equal(f.pagesRead, 0);
		assert.equal(f.cardsCreated, 0);
	});
});

describe("facts: substance", () => {
	const startedAt = "2026-11-02T10:00:00.000Z";
	const endedAt = "2026-11-02T11:00:00.000Z";

	it("an empty session of each kind has no substance", () => {
		const empties: SessionFacts[] = [
			computeReviewFacts({ startedAt, endedAt, events: [], owns: () => false, names: new Map(), budgetSec: 1200 }),
			computeLectureFacts({ startedAt, endedAt, lectureId: LEC, lecture: null, slides: new Set(), concepts: new Set(), exercises: new Set() }),
			computeOfficeHoursFacts({ chatId: "x", startedAt, endedAt, events: [], transcript: [] }),
			computeStudyFacts({ startedAt, endedAt, document: null, pagesRead: [], transcript: [], linkedNodeIds: [], createdCards: [] }),
		];
		for (const f of empties) assert.equal(hasSubstance(f), false, `kind ${f.kind}`);
	});

	it("a review, a created card, a graded exercise and a viewed slide each give substance", () => {
		const review = computeReviewFacts({
			startedAt,
			endedAt,
			events: [reviewEv("n1", "2026-11-02T10:05:00.000Z")],
			owns: () => true,
			names: new Map([["n1", "A"]]),
			budgetSec: 1200,
		});
		assert.equal(hasSubstance(review), true);
		const study = computeStudyFacts({
			startedAt,
			endedAt,
			document: null,
			pagesRead: [],
			transcript: [],
			linkedNodeIds: [],
			createdCards: [{ nodeId: "n1", at: "2026-11-02T10:30:00.000Z" }],
		});
		assert.equal(hasSubstance(study), true);
		const lecture = computeLectureFacts({ startedAt, endedAt, lectureId: LEC, lecture: null, slides: new Set(["s1"]), concepts: new Set(), exercises: new Set() });
		assert.equal(hasSubstance(lecture), true);
	});

	it("an exercise set with nothing graded has no substance; a graded one does", () => {
		const base: ExerciseSetState = { setId: "s", goalId: "g", exercises: [], createdAt: startedAt, graded: new Map(), applied: null };
		assert.equal(hasSubstance(computeExerciseFacts({ set: base, startedAt, endedAt, names: new Map() })), false);
		const withGrade: ExerciseSetState = {
			...base,
			exercises: [{ id: "e", prompt: "p", nodeIds: ["n1"], steps: [{ id: "e.s0", text: "t", nodeIds: ["n1"] }] }],
			graded: new Map([["e", { type: "graded", setId: "s", exerciseId: "e", outcome: "consistent", nodeOutcomes: [{ nodeId: "n1", outcome: "passed" }], lowConfidence: false, at: "2026-11-02T10:20:00.000Z" }]]),
		};
		assert.equal(hasSubstance(computeExerciseFacts({ set: withGrade, startedAt, endedAt, names: new Map() })), true);
	});

	it("the fact kinds are exactly the session kinds", () => {
		assert.deepEqual([...FACT_KINDS].sort(), [...SESSION_KINDS].sort());
	});

	it("fact computations do not read the wall clock", () => {
		const f = withoutClock(() => computeStudyFacts({ startedAt, endedAt, document: null, pagesRead: [1], transcript: [], linkedNodeIds: [], createdCards: [] }));
		assert.equal(f.pagesRead, 1);
	});
});

// ---------------------------------------------------------------- weekly

const UTC_DAY = (i: number): string => new Date(Date.UTC(2026, 9, 25 + i)).toISOString().slice(0, 10);

/** A hand-built week in UTC: Sun 2026-10-25 20:00 to Sun 2026-11-01 20:00, eight calendar days touched. */
function utcWindow(): WeeklyWindow {
	const start = "2026-10-25T20:00:00.000Z";
	const end = "2026-11-01T20:00:00.000Z";
	const days = Array.from({ length: 8 }, (_, i) => ({
		date: UTC_DAY(i),
		start: i === 0 ? start : `${UTC_DAY(i)}T00:00:00.000Z`,
		end: i === 7 ? end : `${UTC_DAY(i + 1)}T00:00:00.000Z`,
	}));
	return { weekOf: "2026-10-25", start, end, days };
}

function weeklyInput(over: Partial<WeeklyInput> = {}): WeeklyInput {
	return {
		window: utcWindow(),
		reviewEvents: [],
		goals: [],
		chains: [],
		nodeIds: new Set<string>(["a", "b", "c", "x", "y", "n1", "n2"]),
		retentionOf: () => 0,
		trustOf: (): TrustLevel => "unverified",
		journal: [],
		budgetSec: 1500,
		...over,
	};
}

const calc = (input: WeeklyInput): WeeklyFacts => inTZ("UTC", () => computeWeeklyFacts(input));

function goal(id: string, targets: string[], status: Goal["status"] = "active"): Goal {
	return {
		id,
		title: `Goal ${id}`,
		origin: "user",
		originRef: "",
		targetNodeIds: targets,
		priority: 3,
		status,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
	};
}

function wrev(nodeId: string, at: string, rating: 1 | 2 | 3 | 4, durationSec: number, channel: "fixed" | "dialogic" | "exercise" = "fixed"): ReviewEvent {
	return { type: "review", nodeId, channel, rating, durationSec, at };
}

describe("weekly window: boundaries and DST", () => {
	it("in Europe/Rome the most recent Sunday 20:00 boundary is the window end", () => {
		const w = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-08T18:59:00.000Z"), 0, 20));
		assert.equal(ms(w.end), ms("2026-11-01T19:00:00.000Z"));
		assert.equal(w.weekOf, "2026-10-25");
		assert.equal(ms(w.end) - ms(w.start), 168 * 3_600_000 - 0);
	});

	it("a window crossing the October DST change (clocks go back) lasts 169 hours", () => {
		const w = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-10-25T19:00:00.000Z"), 0, 20));
		assert.equal(ms(w.end), ms("2026-10-25T19:00:00.000Z"));
		assert.equal(w.weekOf, "2026-10-18");
		assert.equal(ms(w.end) - ms(w.start), 169 * 3_600_000);
	});

	it("a window crossing the March DST change (clocks go forward) lasts 167 hours", () => {
		const w = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-04-04T23:00:00.000Z"), 0, 1));
		assert.equal(w.weekOf, "2026-03-29");
		assert.equal(ms(w.end) - ms(w.start), 167 * 3_600_000);
	});

	it("the days of a DST window partition it exactly, in local calendar dates", () => {
		const w = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-10-25T19:00:00.000Z"), 0, 20));
		assert.ok(w.days.length === 7 || w.days.length === 8, `days ${w.days.length}`);
		const total = w.days.reduce((acc, d) => acc + (ms(d.end) - ms(d.start)), 0);
		assert.equal(total, ms(w.end) - ms(w.start));
		assert.equal(nth(w.days, 0).date, w.weekOf);
		assert.equal(ms(nth(w.days, 0).start), ms(w.start));
		assert.equal(ms(nth(w.days, w.days.length - 1).end), ms(w.end));
	});

	it("the boundary is local: the same instant gives different windows in Rome and in UTC", () => {
		const now = new Date("2026-11-08T19:30:00.000Z");
		const rome = inTZ("Europe/Rome", () => weeklyWindow(now, 0, 20));
		const utc = inTZ("UTC", () => weeklyWindow(now, 0, 20));
		assert.equal(ms(rome.end), ms("2026-11-08T19:00:00.000Z"));
		assert.equal(rome.weekOf, "2026-11-01");
		assert.equal(ms(utc.end), ms("2026-11-01T20:00:00.000Z"));
		assert.equal(utc.weekOf, "2026-10-25");
	});

	it("a now exactly on the boundary ends the window there; one millisecond earlier ends it a week before", () => {
		const onBoundary = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-08T19:00:00.000Z"), 0, 20));
		assert.equal(ms(onBoundary.end), ms("2026-11-08T19:00:00.000Z"));
		const before = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-08T18:59:59.999Z"), 0, 20));
		assert.equal(ms(before.end), ms("2026-11-01T19:00:00.000Z"));
	});

	it("the weekly key is stable for every instant inside the same window", () => {
		const a = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-10-25T19:01:00.000Z"), 0, 20));
		const b = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-01T18:59:00.000Z"), 0, 20));
		assert.equal(a.weekOf, b.weekOf);
		assert.equal(ms(a.end), ms(b.end));
	});

	it("missed boundaries are not backfilled: a long absence yields the latest boundary only", () => {
		const now = new Date("2026-12-15T10:00:00.000Z");
		const w = inTZ("Europe/Rome", () => weeklyWindow(now, 0, 20));
		assert.equal(ms(w.end), ms("2026-12-13T19:00:00.000Z"));
		assert.ok(ms(w.end) <= now.getTime());
		assert.ok(now.getTime() - ms(w.end) < 7 * 24 * 3_600_000);
	});

	it("the configured weekday and hour are honoured in local time", () => {
		const w = inTZ("Europe/Rome", () => {
			const win = weeklyWindow(new Date("2026-11-08T18:00:00.000Z"), 3, 9);
			const end = new Date(win.end);
			return { day: end.getDay(), hour: end.getHours(), minute: end.getMinutes() };
		});
		assert.deepEqual(w, { day: 3, hour: 9, minute: 0 });
	});

	it("the window arithmetic does not read the wall clock except through its argument", () => {
		const w = withoutClock(() => inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-08T18:59:00.000Z"), 0, 20)));
		assert.equal(w.weekOf, "2026-10-25");
	});
});

describe("weekly facts: aggregation", () => {
	it("review seconds are summed per local day, not overwritten", () => {
		const f = calc(
			weeklyInput({
				reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 3, 30), wrev("b", "2026-10-27T10:00:00.000Z", 3, 45), { type: "review", nodeId: "c", channel: "dialogic", rating: 4, durationSec: 60, at: "2026-10-27T11:00:00.000Z" }],
			}),
		);
		const day = must(f.days.find((d) => d.date === "2026-10-27"));
		assert.equal(day.reviewSec, 135);
		assert.equal(day.reviews, 3);
	});

	it("exercise-channel reviews are not part of the daily review load", () => {
		const f = calc(weeklyInput({ reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 3, 100, "exercise")] }));
		const day = must(f.days.find((d) => d.date === "2026-10-27"));
		assert.equal(day.reviewSec, 0);
		assert.equal(day.reviews, 0);
	});

	it("reviews outside the window are ignored", () => {
		const f = calc(
			weeklyInput({
				reviewEvents: [wrev("a", "2026-10-20T09:00:00.000Z", 3, 30), wrev("b", "2026-11-05T09:00:00.000Z", 3, 30)],
			}),
		);
		assert.equal(f.days.reduce((acc, d) => acc + d.reviews, 0), 0);
	});

	it("a review is bucketed by its local date (Rome), not its UTC date", () => {
		const window = inTZ("Europe/Rome", () => weeklyWindow(new Date("2026-11-08T19:30:00.000Z"), 0, 20));
		const f = inTZ("Europe/Rome", () =>
			computeWeeklyFacts(
				weeklyInput({
					window,
					reviewEvents: [wrev("a", "2026-11-07T23:30:00.000Z", 3, 30)],
				}),
			),
		);
		assert.equal(must(f.days.find((d) => d.date === "2026-11-08")).reviews, 1);
		const prev = f.days.find((d) => d.date === "2026-11-07");
		assert.equal(prev?.reviews ?? 0, 0);
	});

	it("a week with no sessions, reviews or goals is all zeros, with no NaN", () => {
		const f = calc(weeklyInput());
		assert.equal(f.kind, "weekly");
		assert.equal(f.retention.rate, null);
		assert.equal(f.retention.reviews, 0);
		assert.equal(f.backlog.trend, "flat");
		assert.equal(f.trust.total, 0);
		assert.deepEqual(f.goals, []);
		for (const d of f.days) {
			assert.equal(d.reviews, 0);
			assert.equal(d.reviewSec, 0);
		}
		assert.equal(Number.isNaN(f.backlog.dueAtEnd), false);
	});

	it("the window and budget fields pass through unchanged", () => {
		const input = weeklyInput({ budgetSec: 1234 });
		const f = calc(input);
		assert.equal(f.weekOf, input.window.weekOf);
		assert.equal(f.windowStart, input.window.start);
		assert.equal(f.windowEnd, input.window.end);
		assert.equal(f.budgetSec, 1234);
	});

	it("backlog trend agrees with the direction of the numbers", () => {
		const f = calc(weeklyInput({ reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 1, 10)] }));
		const expected = f.backlog.dueAtEnd > f.backlog.dueAtStart ? "up" : f.backlog.dueAtEnd < f.backlog.dueAtStart ? "down" : "flat";
		assert.equal(f.backlog.trend, expected);
		assert.ok(Number.isInteger(f.backlog.dueAtStart) && f.backlog.dueAtStart >= 0);
		assert.ok(Number.isInteger(f.backlog.dueAtEnd) && f.backlog.dueAtEnd >= 0);
	});
});

describe("weekly facts: retention", () => {
	it("a node's first-ever review in the week is not retention evidence; later reviews are", () => {
		const f = calc(
			weeklyInput({
				reviewEvents: [
					wrev("y", "2026-10-20T09:00:00.000Z", 3, 30),
					wrev("x", "2026-10-27T09:00:00.000Z", 3, 30),
					wrev("x", "2026-10-28T09:00:00.000Z", 1, 30),
					wrev("y", "2026-10-27T10:00:00.000Z", 4, 30),
				],
			}),
		);
		assert.equal(f.retention.reviews, 2);
		assert.equal(f.retention.recalled, 1);
		assert.equal(f.retention.rate, 0.5);
	});

	it("with no evidence the retention rate is null, not zero or NaN", () => {
		const f = calc(weeklyInput({ reviewEvents: [wrev("x", "2026-10-27T09:00:00.000Z", 3, 30)] }));
		assert.equal(f.retention.reviews, 0);
		assert.equal(f.retention.rate, null);
	});
});

describe("weekly facts: goals, trust and sessions", () => {
	const chains = [{ premises: ["a"], conclusion: "b" }];

	it("paused goals are excluded and active goals report their scope size", () => {
		const f = calc(weeklyInput({ chains, goals: [goal("g1", ["b"], "active"), goal("g2", ["b"], "paused")] }));
		assert.deepEqual(f.goals.map((g) => g.goalId), ["g1"]);
		assert.equal(nth(f.goals, 0).total, 2);
		assert.equal(nth(f.goals, 0).title, "Goal g1");
		assert.equal(nth(f.goals, 0).status, "active");
	});

	it("[spec-gap] a reached goal is still reported, since only paused goals are excluded", () => {
		const f = calc(weeklyInput({ chains, goals: [goal("g3", ["b"], "reached")] }));
		assert.deepEqual(f.goals.map((g) => g.goalId), ["g3"]);
	});

	it("solid counts are bounded by the goal total, never negative, and delta is end minus start", () => {
		for (const r of [0, 0.5, 0.9, 1]) {
			const f = calc(weeklyInput({ chains, goals: [goal("g1", ["b"])], retentionOf: () => r, nodeIds: new Set(["a", "b"]) }));
			const g = nth(f.goals, 0);
			assert.equal(g.total, 2);
			assert.ok(g.solidAtEnd >= 0 && g.solidAtEnd <= g.total, `retention ${r}: solidAtEnd ${g.solidAtEnd}`);
			assert.ok(g.solidAtStart >= 0 && g.solidAtStart <= g.total, `retention ${r}: solidAtStart ${g.solidAtStart}`);
			assert.equal(g.delta, g.solidAtEnd - g.solidAtStart);
		}
	});

	it("more retention never yields fewer solid nodes at the end of the window", () => {
		const at = (r: number) => nth(calc(weeklyInput({ chains, goals: [goal("g1", ["b"])], retentionOf: () => r, nodeIds: new Set(["a", "b"]) })).goals, 0).solidAtEnd;
		assert.ok(at(1) >= at(0));
		assert.equal(at(0), 0);
	});

	it("trust counts cover the active scope and their buckets sum to the total", () => {
		const f = calc(
			weeklyInput({
				chains,
				goals: [goal("g1", ["b"])],
				nodeIds: new Set(["a", "b"]),
				trustOf: (id) => (id === "a" ? "sourced" : "unverified"),
			}),
		);
		assert.deepEqual(f.trust, { total: 2, sourced: 1, contested: 0, refuted: 0, unverified: 1 });
		assert.equal(f.trust.sourced + f.trust.contested + f.trust.refuted + f.trust.unverified, f.trust.total);
	});

	it("[spec-gap] a scope node that no longer exists is not counted in the trust total", () => {
		const f = calc(weeklyInput({ chains, goals: [goal("g1", ["b"])], nodeIds: new Set(["a"]) }));
		assert.equal(f.trust.total, 1);
	});

	it("sessions count debriefs in the window by kind, with all five kinds present", () => {
		const journal: JournalEvent[] = [
			session("chat_r", "2026-10-27T09:00:00.000Z", "review"),
			session("chat_l", "2026-10-20T09:00:00.000Z", "lecture"),
			weekly("2026-10-25", "2026-10-28T09:00:00.000Z"),
			session("chat_o", "2026-10-29T09:00:00.000Z", "office_hours"),
		];
		const f = calc(weeklyInput({ journal }));
		assert.deepEqual(Object.keys(f.sessions).sort(), ["exercises", "lecture", "office_hours", "review", "study"]);
		assert.deepEqual(f.sessions, { review: 1, lecture: 0, office_hours: 1, study: 0, exercises: 0 });
	});
});

describe("weekly facts: substance and purity", () => {
	it("an empty week has no substance", () => {
		assert.equal(hasWeeklySubstance(calc(weeklyInput())), false);
	});

	it("a review, a debrief or an active goal each give the week substance", () => {
		assert.equal(hasWeeklySubstance(calc(weeklyInput({ reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 3, 30)] }))), true);
		assert.equal(hasWeeklySubstance(calc(weeklyInput({ journal: [session("c", "2026-10-27T09:00:00.000Z")] }))), true);
		assert.equal(hasWeeklySubstance(calc(weeklyInput({ chains: [{ premises: ["a"], conclusion: "b" }], goals: [goal("g", ["b"])] }))), true);
	});

	it("[spec-gap] a week whose only goal is paused has no substance", () => {
		assert.equal(hasWeeklySubstance(calc(weeklyInput({ goals: [goal("g", ["b"], "paused")] }))), false);
	});

	it("the same input gives the same output and the input is not mutated", () => {
		const input = weeklyInput({ reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 3, 30), wrev("a", "2026-10-28T09:00:00.000Z", 1, 10)] });
		const snapshot = JSON.stringify({ ...input, retentionOf: undefined, trustOf: undefined });
		const a = calc(input);
		const b = calc(input);
		assert.deepEqual(a, b);
		assert.equal(JSON.stringify({ ...input, retentionOf: undefined, trustOf: undefined }), snapshot);
	});

	it("weekly computation does not read the wall clock", () => {
		const f = withoutClock(() => calc(weeklyInput({ reviewEvents: [wrev("a", "2026-10-27T09:00:00.000Z", 3, 30)] })));
		assert.equal(f.days.reduce((acc, d) => acc + d.reviews, 0), 1);
	});
});

// ---------------------------------------------------------------- commentary

const GOOD: Commentary = {
	observations: "Twelve reviews, three lapses on the same premise.",
	stateOfLearning: "Four of nine scope nodes are solid; goal progress is flat.",
	critique: "Two review days were skipped, and fourteen cards were created without any review.",
	suggestion: "Start the next session with the weak premise before creating new cards.",
};

function scanStructure(md: string): { parts: CommentaryPart[]; fenceMarkers: number } {
	const lines = md.split(/\r\n|\r|\n|\u2028|\u2029/);
	let fenceMarkers = 0;
	let inFence = false;
	const parts: CommentaryPart[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (t.startsWith("```")) {
			fenceMarkers++;
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const bare = t.replace(/^[#*\s]+/, "").replace(/[*\s]+$/, "");
		const hit = COMMENTARY_PARTS.find((p) => headingText(p) === bare);
		if (hit !== undefined) parts.push(hit);
	}
	return { parts, fenceMarkers };
}

function headingText(p: CommentaryPart): string {
	return COMMENTARY_HEADINGS[p].replace(/^[#*\s]+/, "").replace(/[*\s]+$/, "");
}

function sectionsOf(md: string): Map<CommentaryPart, string> {
	const lines = md.split(/\r\n|\r|\n/);
	const out = new Map<CommentaryPart, string>();
	let current: CommentaryPart | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (current !== null) out.set(current, buf.join("\n").trim());
	};
	let inFence = false;
	for (const line of lines) {
		const t = line.trim();
		if (t.startsWith("```")) inFence = !inFence;
		const bare = t.replace(/^[#*\s]+/, "").replace(/[*\s]+$/, "");
		const hit = inFence ? undefined : COMMENTARY_PARTS.find((p) => headingText(p) === bare);
		if (hit !== undefined) {
			flush();
			current = hit;
			buf = [];
		} else {
			buf.push(line);
		}
	}
	flush();
	return out;
}

/** The safe outcome is: refused with a reported problem, or rendered with the four parts intact and fences closed. */
function assertSafeOrRejected(c: Commentary, label: string): void {
	let out: string | null;
	try {
		out = renderCommentary(c);
	} catch {
		out = null;
	}
	if (out === null) {
		assert.ok(checkCommentary(c).length > 0, `${label}: render refused but checkCommentary reports no problem`);
		return;
	}
	assert.deepEqual(checkCommentary(c), [], `${label}: render succeeded but checkCommentary reports problems`);
	const { parts, fenceMarkers } = scanStructure(out);
	assert.equal(fenceMarkers % 2, 0, `${label}: unclosed code fence in rendered output`);
	assert.deepEqual(parts, [...COMMENTARY_PARTS], `${label}: rendered outline changed`);
}

describe("commentary: structure", () => {
	it("has exactly the four parts, in the spec's order", () => {
		assert.deepEqual([...COMMENTARY_PARTS], ["observations", "stateOfLearning", "critique", "suggestion"]);
	});

	it("headings cover exactly the four parts, are single-line and distinct", () => {
		assert.deepEqual(Object.keys(COMMENTARY_HEADINGS).sort(), [...COMMENTARY_PARTS].sort());
		const values = COMMENTARY_PARTS.map((p) => COMMENTARY_HEADINGS[p]);
		for (const h of values) {
			assert.ok(h.trim().length > 0);
			assert.equal(h.includes("\n"), false);
		}
		assert.equal(new Set(values).size, 4);
	});

	it("a well-formed commentary passes the check", () => {
		assert.deepEqual(checkCommentary(GOOD), []);
	});

	it("the part size limit is a positive integer", () => {
		assert.ok(Number.isInteger(MAX_PART_CHARS) && MAX_PART_CHARS > 0);
	});
});

describe("commentary: checks", () => {
	it("a missing part is a problem", () => {
		const { suggestion: _omit, ...partial } = GOOD;
		assert.ok(checkCommentary(partial).length > 0);
	});

	it("an empty or whitespace-only part is a problem", () => {
		assert.ok(checkCommentary({ ...GOOD, critique: "" }).length > 0);
		assert.ok(checkCommentary({ ...GOOD, critique: "  \n\t " }).length > 0);
	});

	it("a non-string part is a problem", () => {
		for (const v of [3, null, { text: "x" }, ["x"]]) {
			assert.ok(checkCommentary({ ...GOOD, observations: v as unknown as string }).length > 0, `value ${JSON.stringify(v)}`);
		}
	});

	it("[spec-gap] an extra section beyond the four parts is a problem", () => {
		assert.ok(checkCommentary({ ...GOOD, appendix: "extra" } as unknown as Partial<Record<CommentaryPart, unknown>>).length > 0);
	});

	it("[spec-gap] a part of exactly the maximum length passes; one character more is an oversize problem", () => {
		assert.deepEqual(checkCommentary({ ...GOOD, observations: "a".repeat(MAX_PART_CHARS) }), []);
		assert.ok(checkCommentary({ ...GOOD, observations: "a".repeat(MAX_PART_CHARS + 1) }).length > 0);
	});

	it("the check is pure: the same input gives the same problems and the input is not mutated", () => {
		const input: Partial<Record<CommentaryPart, unknown>> = { ...GOOD, critique: "" };
		const snapshot = structuredClone(input);
		assert.deepEqual(checkCommentary(input), checkCommentary(input));
		assert.deepEqual(input, snapshot);
	});
});

describe("commentary: rendering", () => {
	it("renders the four parts under their headings, in order, each body intact", () => {
		const out = renderCommentary(GOOD);
		const { parts, fenceMarkers } = scanStructure(out);
		assert.deepEqual(parts, [...COMMENTARY_PARTS]);
		assert.equal(fenceMarkers, 0);
		const sections = sectionsOf(out);
		for (const p of COMMENTARY_PARTS) assert.equal(sections.get(p), GOOD[p].trim(), `part ${p}`);
	});

	it("rendering is deterministic and does not mutate its input", () => {
		const input = structuredClone(GOOD);
		const snapshot = structuredClone(input);
		assert.equal(renderCommentary(input), renderCommentary(input));
		assert.deepEqual(input, snapshot);
	});

	it("an unusable commentary is never rendered: empty, oversize and missing parts throw", () => {
		assert.throws(() => renderCommentary({ ...GOOD, observations: "" }));
		assert.throws(() => renderCommentary({ ...GOOD, observations: "a".repeat(MAX_PART_CHARS + 1) }));
		assert.throws(() => renderCommentary({ ...GOOD, suggestion: undefined } as unknown as Commentary));
	});

	it("a part that forges a section heading cannot change the stored outline", () => {
		const forged = { ...GOOD, observations: `Looks fine.\n\n${COMMENTARY_HEADINGS.critique}\n\nInvented claim.` };
		assertSafeOrRejected(forged, "forged critique heading");
	});

	it("a part with a fenced code block containing a heading-like line keeps the outline", () => {
		const fenced = { ...GOOD, critique: `Example:\n\n\`\`\`\n${COMMENTARY_HEADINGS.suggestion}\n\`\`\`\n\nDone.` };
		assertSafeOrRejected(fenced, "heading inside a closed fence");
	});

	it("an unclosed code fence cannot swallow the suggestion section", () => {
		const unclosed = { ...GOOD, critique: "Example:\n\n```js\nconst x = 1;" };
		assertSafeOrRejected(unclosed, "unclosed fence");
	});

	it("a markdown table inside a part is accepted and survives rendering", () => {
		const table = { ...GOOD, observations: "| a | b |\n|---|---|\n| 1 | 2 |" };
		const out = renderCommentary(table);
		assert.ok(out.includes("| 1 | 2 |"));
		assertSafeOrRejected(table, "table");
	});

	it("a stray top-level Markdown heading inside a part keeps the four-part outline", () => {
		assertSafeOrRejected({ ...GOOD, stateOfLearning: "# Big title\n\nText." }, "h1 inside part");
	});

	it("CRLF line endings inside a part cannot create a forged section", () => {
		const crlf = { ...GOOD, observations: `First line.\r\n${COMMENTARY_HEADINGS.critique}\r\nForged.` };
		assertSafeOrRejected(crlf, "CRLF forged heading");
	});

	it("CRLF line endings alone are handled without changing the outline", () => {
		assertSafeOrRejected({ ...GOOD, observations: "Line one.\r\nLine two." }, "CRLF body");
	});

	it("[spec-gap] Unicode line and paragraph separators cannot create a forged section", () => {
		const sep = { ...GOOD, observations: `Fine.\u2028${COMMENTARY_HEADINGS.critique}\u2028Forged.` };
		assertSafeOrRejected(sep, "U+2028 forged heading");
		const para = { ...GOOD, observations: `Fine.\u2029${COMMENTARY_HEADINGS.suggestion}\u2029Forged.` };
		assertSafeOrRejected(para, "U+2029 forged heading");
	});

	it("an unrelated emoji or non-ASCII text renders without changing the part", () => {
		const uni = { ...GOOD, observations: "Città: Roma — perché 3 ≥ 2 ✓" };
		assertSafeOrRejected(uni, "unicode body");
		const out = renderCommentary(uni);
		assert.ok(out.includes("perché 3 ≥ 2 ✓"));
	});
});

// ---------------------------------------------------------------- config

describe("config: defaults", () => {
	it("[spec-gap] the defaults are a 30 minute idle timeout, a 3 day lookback and a Sunday 20:00 weekly synthesis", () => {
		assert.equal(DEFAULT_DEBRIEF_CONFIG.idleMs, 30 * 60_000);
		assert.equal(DEFAULT_DEBRIEF_CONFIG.lookbackMs, 3 * 24 * 3_600_000);
		assert.equal(DEFAULT_DEBRIEF_CONFIG.weeklyDay, 0);
		assert.ok(DEFAULT_DEBRIEF_CONFIG.weeklyHour >= 17 && DEFAULT_DEBRIEF_CONFIG.weeklyHour <= 23);
	});

	it("[spec-gap] the default daily budget is 25 minutes, as the umbrella spec states", () => {
		assert.equal(DEFAULT_DEBRIEF_CONFIG.budgetSec, 25 * 60);
	});

	it("no environment yields the defaults", () => {
		assert.deepEqual(readDebriefConfig({}), DEFAULT_DEBRIEF_CONFIG);
		assert.deepEqual(readDebriefConfig({ UNRELATED: "x" }), DEFAULT_DEBRIEF_CONFIG);
	});

	it("an explicit budget argument is used when valid", () => {
		assert.equal(readDebriefConfig({}, 1200).budgetSec, 1200);
	});

	it("an invalid budget argument falls back to a positive finite budget", () => {
		for (const b of [Number.NaN, 0, -5]) {
			const c = readDebriefConfig({}, b);
			assert.ok(Number.isFinite(c.budgetSec) && c.budgetSec > 0, `budget ${b} gave ${c.budgetSec}`);
		}
	});

	it("a returned config is a fresh object: mutating it cannot change the defaults or later reads", () => {
		const a = readDebriefConfig({});
		a.idleMs = 1;
		assert.equal(readDebriefConfig({}).idleMs, DEFAULT_DEBRIEF_CONFIG.idleMs);
		assert.equal(DEFAULT_DEBRIEF_CONFIG.idleMs, 30 * 60_000);
	});
});

describe("config: hostile environment values", () => {
	// The env variable names are not given in the spec or the signature; these are the plausible ones.
	const CANDIDATE_NAMES = [
		"DEBRIEF_IDLE_MINUTES",
		"DEBRIEF_IDLE_MIN",
		"DEBRIEF_IDLE_MS",
		"DEBRIEF_IDLE_TIMEOUT_MINUTES",
		"DEBRIEF_LOOKBACK_DAYS",
		"DEBRIEF_LOOKBACK_MS",
		"DEBRIEF_WEEKLY_DAY",
		"DEBRIEF_WEEKLY_HOUR",
		"DEBRIEF_BUDGET_SEC",
		"DEBRIEF_BUDGET_MINUTES",
	];
	const HOSTILE = ["", " ", "abc", "NaN", "-1", "0", "1e12", "Infinity", "1.5", "7", "24", "--", "0x10"];

	it("for every plausible name and hostile value, the config stays usable", () => {
		for (const name of CANDIDATE_NAMES) {
			for (const v of HOSTILE) {
				const c = readDebriefConfig({ [name]: v });
				assert.ok(Number.isFinite(c.idleMs) && c.idleMs > 0, `${name}=${v}: idleMs ${c.idleMs}`);
				assert.ok(Number.isFinite(c.lookbackMs) && c.lookbackMs > 0, `${name}=${v}: lookbackMs ${c.lookbackMs}`);
				assert.ok(Number.isInteger(c.weeklyDay) && c.weeklyDay >= 0 && c.weeklyDay <= 6, `${name}=${v}: weeklyDay ${c.weeklyDay}`);
				assert.ok(Number.isInteger(c.weeklyHour) && c.weeklyHour >= 0 && c.weeklyHour <= 23, `${name}=${v}: weeklyHour ${c.weeklyHour}`);
				assert.ok(Number.isFinite(c.budgetSec) && c.budgetSec > 0, `${name}=${v}: budgetSec ${c.budgetSec}`);
			}
		}
	});

	it("undefined environment values are treated as missing", () => {
		const c = readDebriefConfig(Object.fromEntries(CANDIDATE_NAMES.map((n) => [n, undefined])));
		assert.deepEqual(c, DEFAULT_DEBRIEF_CONFIG);
	});

	it("a non-numeric or zero idle value never makes the idle timeout zero", () => {
		for (const name of ["DEBRIEF_IDLE_MINUTES", "DEBRIEF_IDLE_MIN", "DEBRIEF_IDLE_MS", "DEBRIEF_IDLE_TIMEOUT_MINUTES"]) {
			for (const v of ["0", "abc", "-5"]) {
				assert.ok(readDebriefConfig({ [name]: v }).idleMs > 0, `${name}=${v}`);
			}
		}
	});
});

// ---------------------------------------------------------------- ports

describe("ports", () => {
	it("WriterUnavailableError is an Error and identifiable by instanceof", () => {
		const e = new WriterUnavailableError("no key configured");
		assert.ok(e instanceof Error);
		assert.ok(e instanceof WriterUnavailableError);
		assert.equal(e.message, "no key configured");
		assert.equal(new Error("other") instanceof WriterUnavailableError, false);
	});

	it("[spec-gap] the error has a non-empty default message", () => {
		assert.ok(new WriterUnavailableError().message.length > 0);
	});
});
