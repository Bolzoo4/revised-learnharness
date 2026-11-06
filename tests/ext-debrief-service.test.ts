// tests/ext-debrief-service.test.ts
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { WriterUnavailableError } from "../src/core/ext/debrief/ports.ts";
import { COST_SOURCE, MAX_COMMENTARY_ATTEMPTS, MAX_PER_SWEEP } from "../src/server/ext/debrief-service.ts";
import { HttpError } from "../src/server/ext/http-error.ts";
import { goodCommentary, harness, local, ref, reviewFacts, weeklyFacts } from "./helpers/debrief-fakes.ts";
import { makeLecture, NODE_A } from "./helpers/lecture-fixture.ts";

afterEach(() => mock.restoreAll());
const quiet = () => mock.method(console, "error", () => {});
const ended = (id: string) => ref(id, local(11, 4, 10)); // 2 h before "now": past the 30-minute idle time
const WEEK = "2026-10-25";

describe("endSession (REQ-deb-01, REQ-deb-04, REQ-deb-05)", () => {
	it("writes the facts with the four-part commentary, records the end and the spend", async () => {
		const h = harness({ refs: [ref("chat_a", local(11, 4, 11, 50))] });
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "created");
		assert.equal(h.journal.events.length, 1);
		const e = h.journal.events[0]!;
		assert.equal(e.sessionId, "chat_a");
		assert.equal(e.sessionKind, "review");
		assert.equal(e.facts.kind, "review");
		assert.match(e.commentary ?? "", /## Observations[\s\S]*## State of learning[\s\S]*## Critique[\s\S]*## Suggestion for the next session/);
		assert.deepEqual(h.activity.events.map((a) => a.type), ["end"]);
		assert.deepEqual(h.gate.recorded, [{ usd: 0.05, source: COST_SOURCE }]);
	});
	it("a bad id is a 400, an unknown session a 404, and nothing is written", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		await assert.rejects(h.service.endSession("has space"), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(h.service.endSession(""), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(h.service.endSession(undefined as unknown as string), (e: unknown) => e instanceof HttpError && e.status === 400);
		await assert.rejects(h.service.endSession("chat_zzz"), (e: unknown) => e instanceof HttpError && e.status === 404);
		assert.equal(h.journal.events.length + h.activity.events.length, 0);
	});
	it("an empty session gets no entry and no model call", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		h.sources.factsOf.set("chat_a", () => reviewFacts(0));
		assert.equal((await h.service.endSession("chat_a")).status, "empty");
		assert.equal(h.journal.events.length, 0);
		assert.equal(h.writer.calls.length, 0);
	});
});

describe("idempotence per session (REQ-deb-10)", () => {
	it("ending twice produces one entry and one model call", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		const first = await h.service.endSession("chat_a");
		const second = await h.service.endSession("chat_a");
		assert.equal(first.status, "created");
		assert.equal(second.status, "exists");
		assert.equal(h.journal.events.length, 1);
		assert.equal(h.writer.calls.length, 1);
		assert.equal(h.activity.events.length, 1);
	});
	it("concurrent end calls and a sweep share one run", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		let release!: () => void;
		const gateOpen = new Promise<void>((r) => (release = r));
		h.writer.behaviour = async () => {
			await gateOpen;
			return { commentary: goodCommentary, costUsd: 0.05, styleVersion: "abc123abc123" };
		};
		const all = Promise.all([h.service.endSession("chat_a"), h.service.endSession("chat_a"), h.service.sweep(), h.service.sweep()]);
		release();
		await all;
		assert.equal(h.writer.calls.filter((c) => c.kind === "session").length, 1);
		assert.equal(h.journal.events.filter((e) => e.sessionId === "chat_a").length, 1);
	});
	it("an entry that appears while the model is working is not duplicated", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		h.writer.behaviour = async () => {
			h.journal.append({ ...(await seedEntry(h)) });
			return { commentary: goodCommentary, costUsd: 0, styleVersion: "abc123abc123" };
		};
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "exists");
		assert.equal(h.journal.events.length, 1);
	});
	it("a session that ended is not debriefed again by a later sweep", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		await h.service.sweep();
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.sessionId === "chat_a").length, 1);
	});
});

async function seedEntry(h: ReturnType<typeof harness>) {
	const { debriefId } = await import("../src/core/ext/debrief/journal.ts");
	return {
		id: debriefId("chat_a"), kind: "session" as const, sessionId: "chat_a", sessionKind: "review" as const, weekOf: null,
		at: h.clock.now.toISOString(), facts: { kind: "review" }, commentary: "## Observations\n\nother\n", nullReason: null, author: "agent" as const,
	};
}

describe("the daily ceiling (REQ-deb-06)", () => {
	it("stores the facts with a null commentary and never calls the model", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		h.gate.open = false;
		const out = await h.service.endSession("chat_a");
		assert.equal(out.status, "created");
		const e = h.journal.events[0]!;
		assert.equal(e.commentary, null);
		assert.equal(e.nullReason, "ceiling");
		assert.equal(e.facts.kind, "review");
		assert.equal(h.writer.calls.length, 0);
		assert.deepEqual(h.gate.recorded, []);
	});
});

describe("a failing or missing model", () => {
	it("no model configured: deferred, nothing stored, never counted as a failure", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		h.writer.behaviour = async () => { throw new WriterUnavailableError(); };
		for (let i = 0; i < MAX_COMMENTARY_ATTEMPTS + 2; i++) assert.deepEqual(await h.service.endSession("chat_a"), { status: "deferred", reason: "unavailable" });
		assert.equal(h.journal.events.length, 0);
		assert.deepEqual(h.gate.recorded, []);
	});
	it("a failing call is retried, then stored with a null commentary and the reason 'error'", async () => {
		quiet();
		const h = harness({ refs: [ended("chat_a")] });
		h.writer.behaviour = async () => { throw new Error("boom: /secret/path sk-123"); };
		for (let i = 1; i < MAX_COMMENTARY_ATTEMPTS; i++) assert.deepEqual(await h.service.endSession("chat_a"), { status: "deferred", reason: "retry" });
		assert.equal(h.journal.events.length, 0);
		const last = await h.service.endSession("chat_a");
		assert.equal(last.status, "created");
		const e = h.journal.events[0]!;
		assert.equal(e.commentary, null);
		assert.equal(e.nullReason, "error");
		assert.ok(!JSON.stringify(e).includes("secret"), "the error text never reaches the journal");
	});
	it("a writer that returns an unusable commentary counts as a failure", async () => {
		quiet();
		const h = harness({ refs: [ended("chat_a")] });
		h.writer.behaviour = async () => ({ commentary: { ...goodCommentary, critique: "" }, costUsd: 0.2, styleVersion: "x" });
		assert.deepEqual(await h.service.endSession("chat_a"), { status: "deferred", reason: "retry" });
		assert.deepEqual(h.gate.recorded, [{ usd: 0.2, source: COST_SOURCE }], "the spend is recorded even when the text is unusable");
	});
});

describe("sweep (REQ-deb-01: inactivity)", () => {
	it("debriefs ended sessions only, oldest first, and leaves an active one alone", async () => {
		const h = harness({ refs: [ref("chat_new", local(11, 4, 11, 0)), ref("chat_old", local(11, 4, 9, 0)), ref("chat_live", local(11, 4, 11, 45))] });
		const r = await h.service.sweep();
		assert.deepEqual(h.journal.events.filter((e) => e.kind === "session").map((e) => e.sessionId), ["chat_old", "chat_new"]);
		assert.equal(r.created >= 2, true);
	});
	it("honours the inactivity boundary exactly (30 minutes)", async () => {
		const h = harness({ refs: [ref("chat_edge", local(11, 4, 11, 30))] });
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.sessionId === "chat_edge").length, 1);
		const h2 = harness({ refs: [ref("chat_edge", local(11, 4, 11, 31))] });
		await h2.service.sweep();
		assert.equal(h2.journal.events.filter((e) => e.sessionId === "chat_edge").length, 0);
	});
	it("takes at most MAX_PER_SWEEP sessions per run; the next run takes the rest", async () => {
		const refs = Array.from({ length: MAX_PER_SWEEP + 2 }, (_, i) => ref(`chat_${i}`, local(11, 4, 8, i)));
		const h = harness({ refs });
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.kind === "session").length, MAX_PER_SWEEP);
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.kind === "session").length, MAX_PER_SWEEP + 2);
	});
	it("one session whose facts cannot be read does not block the others", async () => {
		quiet();
		const h = harness({ refs: [ref("chat_bad", local(11, 4, 8)), ref("chat_ok", local(11, 4, 9))] });
		h.sources.factsOf.set("chat_bad", () => { throw new Error("stamp newer than this build"); });
		const r = await h.service.sweep();
		assert.equal(r.errors, 1);
		assert.deepEqual(h.journal.events.filter((e) => e.kind === "session").map((e) => e.sessionId), ["chat_ok"]);
	});
	it("an empty session is evaluated once, not on every tick", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		h.sources.factsOf.set("chat_a", () => reviewFacts(0));
		await h.service.sweep();
		const first = h.sources.calls.sessionFacts;
		await h.service.sweep();
		assert.equal(h.sources.calls.sessionFacts, first);
	});
	it("two overlapping sweeps are one", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		const [a, b] = await Promise.all([h.service.sweep(), h.service.sweep()]);
		assert.strictEqual(a, b);
	});
	it("an explicit end older than the lookback is still debriefed", async () => {
		const old = ref("chat_old", local(10, 1, 9));
		const h = harness({ refs: [old], activity: [{ type: "end", sessionId: "chat_old", at: local(10, 1, 10).toISOString() }] });
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.sessionId === "chat_old").length, 1);
	});
});

describe("weekly synthesis (REQ-deb-02)", () => {
	it("is produced once for the latest weekly boundary, with weekOf and facts", async () => {
		const h = harness();
		await h.service.sweep();
		await h.service.sweep();
		const weeklies = h.journal.events.filter((e) => e.kind === "weekly");
		assert.equal(weeklies.length, 1);
		assert.equal(weeklies[0]?.weekOf, WEEK);
		assert.equal(weeklies[0]?.facts.kind, "weekly");
		assert.equal(h.sources.calls.weeklyFacts, 1);
	});
	it("a new week after the next boundary gets its own entry; the old one stays", async () => {
		const h = harness();
		await h.service.sweep();
		h.clock.now = local(11, 8, 19); // Sunday 2026-11-08 after 18:00
		await h.service.sweep();
		assert.deepEqual(h.journal.events.filter((e) => e.kind === "weekly").map((e) => e.weekOf), [WEEK, "2026-11-01"]);
	});
	it("opening the app after a long absence yields one synthesis, not a queue", async () => {
		const h = harness({ now: local(12, 20, 9) });
		await h.service.sweep();
		assert.equal(h.journal.events.filter((e) => e.kind === "weekly").length, 1);
	});
	it("a week with no activity and no active goal is skipped", async () => {
		const h = harness();
		h.sources.weekly = () => weeklyFacts(false);
		const r = await h.service.sweep();
		assert.equal(r.weekly, "empty");
		assert.equal(h.journal.events.length, 0);
	});
	it("at the ceiling the weekly entry keeps its facts and has a null commentary", async () => {
		const h = harness();
		h.gate.open = false;
		await h.service.sweep();
		const w = h.journal.events.find((e) => e.kind === "weekly");
		assert.equal(w?.commentary, null);
		assert.equal(w?.nullReason, "ceiling");
	});
	it("session debriefs of the sweep come before the weekly one", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		await h.service.sweep();
		assert.deepEqual(h.journal.events.map((e) => e.kind), ["session", "weekly"]);
	});
});

describe("history and reads (REQ-deb-08)", () => {
	it("lists newest first and gets one entry by id; an unknown or odd id is a 404", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		await h.service.sweep();
		const { entries } = h.service.list();
		assert.equal(entries.length, 2);
		assert.equal(h.service.get(entries[0]!.id).id, entries[0]!.id);
		for (const bad of ["deb_000000000000", "", "../x", undefined as unknown as string]) {
			assert.throws(() => h.service.get(bad), (e: unknown) => e instanceof HttpError && e.status === 404);
		}
	});
	it("openSessions lists running sessions only, newest activity first, bounded", () => {
		const h = harness({ refs: [ended("chat_done"), ref("chat_live1", local(11, 4, 11, 50)), ref("chat_live2", local(11, 4, 11, 55))] });
		assert.deepEqual(h.service.openSessions().map((s) => s.sessionId), ["chat_live2", "chat_live1"]);
		assert.equal(h.service.openSessions(1).length, 1);
	});
});

describe("REQ-deb-07: a debrief only writes the journal, the activity ledger and the spend", () => {
	it("the service has no handle on goals, review or cards (its deps are the whole surface)", async () => {
		const h = harness({ refs: [ended("chat_a")] });
		const before = JSON.stringify([h.sources.refs]);
		await h.service.sweep();
		assert.equal(JSON.stringify([h.sources.refs]), before);
		assert.ok(h.gate.recorded.every((r) => r.source === COST_SOURCE));
	});
});

describe("recordLectureActivity (the player's trace, REQ-deb-01 for lectures)", () => {
	const lecture = makeLecture();
	const S = "lecs_abcdefgh12";
	const withLecture = () => harness({ lecture: (id) => (id === lecture.id ? lecture : null) });
	const view = (slideId: string, over: Record<string, unknown> = {}) => ({ type: "lecture_view" as const, sessionId: S, lectureId: lecture.id, slideId, ...over });

	it("records views, concepts and exercises once each", () => {
		const h = withLecture();
		assert.deepEqual(h.service.recordLectureActivity(view("s1")), { recorded: true });
		assert.deepEqual(h.service.recordLectureActivity(view("s1")), { recorded: false });
		assert.deepEqual(h.service.recordLectureActivity({ type: "concept_open", sessionId: S, lectureId: lecture.id, nodeId: NODE_A }), { recorded: true });
		assert.deepEqual(h.service.recordLectureActivity({ type: "exercise_done", sessionId: S, lectureId: lecture.id, blockId: "b2" }), { recorded: true });
		assert.equal(h.activity.events.length, 3);
	});
	it("rejects what the lecture does not contain", () => {
		const h = withLecture();
		const bad = (fn: () => unknown, status: number) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === status);
		bad(() => h.service.recordLectureActivity(view("nope")), 400);
		bad(() => h.service.recordLectureActivity({ type: "exercise_done", sessionId: S, lectureId: lecture.id, blockId: "b1" }), 400); // a narrate block is not an exercise
		bad(() => h.service.recordLectureActivity({ type: "concept_open", sessionId: S, lectureId: lecture.id, nodeId: "n_unrelated" }), 400);
		bad(() => h.service.recordLectureActivity(view("s1", { lectureId: "lec_b00000000_c01_l01" })), 404);
		bad(() => h.service.recordLectureActivity(view("s1", { sessionId: "chat_a" })), 400);
		assert.equal(h.activity.events.length, 0);
	});
	it("a session cannot switch lecture, and cannot continue after it ended", () => {
		const h = withLecture();
		h.service.recordLectureActivity(view("s1"));
		const other = makeLecture({ id: "lec_b0123abcd_c02_l02" });
		const h2 = harness({ lecture: (id) => (id === lecture.id ? lecture : id === other.id ? other : null), activity: [...h.activity.events] });
		assert.throws(() => h2.service.recordLectureActivity({ type: "lecture_view", sessionId: S, lectureId: other.id, slideId: "s1" }), (e: unknown) => e instanceof HttpError && e.status === 409);
		h.activity.append({ type: "end", sessionId: S, at: h.clock.now.toISOString() });
		assert.throws(() => h.service.recordLectureActivity(view("s2")), (e: unknown) => e instanceof HttpError && e.status === 409);
	});
});
