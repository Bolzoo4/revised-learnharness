// tests/ext-debrief-journal.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	debriefId,
	deriveJournal,
	findDebrief,
	keyOf,
	parseJournalEvent,
	recentDebriefs,
	sessionKey,
	weeklyKey,
	type JournalEvent,
} from "../src/core/ext/debrief/journal.ts";

const facts = (kind: string) => ({ kind });
const session = (sessionId: string, at: string, over: Partial<JournalEvent> = {}): JournalEvent => ({
	id: debriefId(sessionKey(sessionId)), kind: "session", sessionId, sessionKind: "review", weekOf: null, at,
	facts: facts("review"), commentary: "## Observations\n\nx\n", nullReason: null, author: "agent", ...over,
});
const weekly = (weekOf: string, at: string): JournalEvent => ({
	id: debriefId(weeklyKey(weekOf)), kind: "weekly", sessionId: null, sessionKind: null, weekOf, at,
	facts: facts("weekly"), commentary: null, nullReason: "ceiling", author: "agent",
});

describe("parseJournalEvent (REQ-deb-05)", () => {
	it("round-trips a session debrief and a weekly synthesis", () => {
		assert.deepEqual(parseJournalEvent(session("chat_a", "2026-11-04T10:00:00.000Z")), session("chat_a", "2026-11-04T10:00:00.000Z"));
		assert.deepEqual(parseJournalEvent(weekly("2026-10-26", "2026-11-01T18:00:00.000Z")), weekly("2026-10-26", "2026-11-01T18:00:00.000Z"));
	});
	it("rejects shapes that would break a reader", () => {
		const ok = session("chat_a", "2026-11-04T10:00:00.000Z");
		const bad: unknown[] = [
			null, "x", [], {},
			{ ...ok, id: "" },
			{ ...ok, at: "yesterday" },
			{ ...ok, author: "user" },
			{ ...ok, kind: "other" },
			{ ...ok, sessionKind: "teaching" },
			{ ...ok, sessionId: "" },
			{ ...ok, weekOf: "2026-10-26" },
			{ ...ok, facts: null },
			{ ...ok, facts: [] },
			{ ...ok, facts: { kind: "lecture" } }, // facts kind must match the session kind
			{ ...ok, commentary: "" },
			{ ...ok, commentary: null }, // null commentary needs a reason
			{ ...ok, nullReason: "ceiling" }, // a commentary and a reason never coexist
			{ ...ok, nullReason: "whim", commentary: null },
			{ ...weekly("2026-10-26", "2026-11-01T18:00:00.000Z"), weekOf: "26/10/2026" },
			{ ...weekly("2026-10-26", "2026-11-01T18:00:00.000Z"), sessionId: "chat_a" },
			{ ...weekly("2026-10-26", "2026-11-01T18:00:00.000Z"), facts: facts("review") },
		];
		for (const b of bad) assert.equal(parseJournalEvent(b), null, JSON.stringify(b));
	});
});

describe("ids and keys", () => {
	it("the id is deterministic per key and 12 hex digits long", () => {
		assert.equal(debriefId("chat_a"), debriefId("chat_a"));
		assert.notEqual(debriefId("chat_a"), debriefId("chat_b"));
		assert.match(debriefId("x"), /^deb_[0-9a-f]{12}$/);
	});
	it("a weekly key cannot collide with a session id", () => {
		assert.equal(keyOf(weekly("2026-10-26", "2026-11-01T18:00:00.000Z")), "weekly:2026-10-26");
		assert.equal(keyOf(session("chat_a", "2026-11-04T10:00:00.000Z")), "chat_a");
	});
});

describe("deriveJournal (REQ-deb-10: at most one debrief per session)", () => {
	it("keeps the first event of a key and drops later duplicates", () => {
		const first = session("chat_a", "2026-11-04T10:00:00.000Z");
		const dup = session("chat_a", "2026-11-04T11:00:00.000Z", { commentary: "## Observations\n\nother\n" });
		const other = session("chat_b", "2026-11-04T12:00:00.000Z");
		const out = deriveJournal([first, dup, other]);
		assert.deepEqual(out.map((e) => e.sessionId), ["chat_a", "chat_b"]);
		assert.equal(out[0]?.commentary, first.commentary);
	});
	it("findDebrief looks a key up and returns null for an unknown one", () => {
		const j = [session("chat_a", "2026-11-04T10:00:00.000Z")];
		assert.equal(findDebrief(j, "chat_a")?.sessionId, "chat_a");
		assert.equal(findDebrief(j, "chat_z"), null);
		assert.equal(findDebrief([], ""), null);
	});
});

describe("recentDebriefs (bounded, newest first)", () => {
	const journal = [
		session("a", "2026-11-01T10:00:00.000Z"),
		session("b", "2026-11-03T10:00:00.000Z", { sessionKind: "lecture", facts: facts("lecture") }),
		weekly("2026-10-26", "2026-11-02T18:00:00.000Z"),
	];
	it("orders newest first", () => {
		assert.deepEqual(recentDebriefs(journal).entries.map((e) => e.sessionId ?? e.weekOf), ["b", "2026-10-26", "a"]);
	});
	it("filters by kind and by since, and reports truncation", () => {
		assert.deepEqual(recentDebriefs(journal, { kind: "weekly" }).entries.map((e) => e.kind), ["weekly"]);
		assert.deepEqual(recentDebriefs(journal, { kind: "lecture" }).entries.map((e) => e.sessionId), ["b"]);
		assert.equal(recentDebriefs(journal, { since: "2026-11-02T00:00:00.000Z" }).count, 2);
		const cut = recentDebriefs(journal, { limit: 2 });
		assert.equal(cut.count, 2);
		assert.equal(cut.truncated, true);
		assert.equal(recentDebriefs(journal, { limit: 3 }).truncated, false);
	});
	it("a NaN, zero, negative or fractional limit falls back to the default; a huge limit is capped", () => {
		const many = Array.from({ length: 260 }, (_, i) => session(`s${i}`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()));
		assert.equal(recentDebriefs(many, { limit: Number.NaN }).entries.length, 50);
		assert.equal(recentDebriefs(many, { limit: 0 }).entries.length, 50);
		assert.equal(recentDebriefs(many, { limit: -3 }).entries.length, 50);
		assert.equal(recentDebriefs(many, { limit: 2.5 }).entries.length, 50);
		assert.equal(recentDebriefs(many, { limit: 10_000 }).entries.length, 200);
	});
	it("an unparseable since is ignored and duplicates are counted once", () => {
		assert.equal(recentDebriefs(journal, { since: "garbage" }).count, 3);
		assert.equal(recentDebriefs([journal[0]!, journal[0]!]).count, 1);
	});
});
