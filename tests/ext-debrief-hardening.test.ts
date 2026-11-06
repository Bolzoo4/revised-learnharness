// Hardening tests for the debrief layer (items 5, 6, 9 and 10 of the 2026-11-06 review).
// The adversarial file covers the attacks; these pin the bounds and rules added after it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDebriefWriter, buildDebriefPrompt, factsBlock, MAX_FACTS_BLOCK_CHARS } from "../src/agent/ext/debrief-writer.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { computeOfficeHoursFacts, type TranscriptLine } from "../src/core/ext/debrief/facts.ts";
import { debriefId, deriveJournal, parseJournalEvent, sessionKey, weeklyKey, type JournalEvent } from "../src/core/ext/debrief/journal.ts";
import { endedAtOf, pendingSessions, type SessionRef } from "../src/core/ext/debrief/sessions.ts";
import { DEFAULT_DEBRIEF_CONFIG } from "../src/core/ext/debrief/config.ts";
import { MAX_PART_CHARS, type Commentary } from "../src/core/ext/debrief/commentary.ts";
import type { WriterRequest } from "../src/core/ext/debrief/ports.ts";
import type { OfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import { createDebriefService, newDebriefState, type DebriefDeps } from "../src/server/ext/debrief-service.ts";
import { createDebriefSources } from "../src/server/ext/debrief-sources.ts";
import type { CostGate } from "../src/core/ext/cost-gate.ts";

const MIN = 60_000;
const NOW = new Date("2026-11-06T10:00:00.000Z");
const ok: Commentary = { observations: "a", stateOfLearning: "b", critique: "c", suggestion: "d" };

function sessionEntry(sessionId: string, extra: Partial<JournalEvent> = {}): JournalEvent {
	return {
		id: debriefId(sessionKey(sessionId)),
		kind: "session",
		sessionId,
		sessionKind: "review",
		weekOf: null,
		at: "2026-11-06T09:00:00.000Z",
		facts: { kind: "review" },
		commentary: "x",
		nullReason: null,
		author: "agent",
		...extra,
	};
}

describe("journal parser bounds and identity (items 5, 10)", () => {
	it("keeps a bounded style version and rejects an unbounded one", () => {
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), styleVersion: "abc123abc123" })?.styleVersion, "abc123abc123");
		assert.equal(parseJournalEvent(sessionEntry("a"))?.styleVersion, undefined, "old lines have no style version");
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), styleVersion: "x".repeat(33) }), null);
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), styleVersion: 7 }), null);
	});

	it("rejects a commentary longer than four parts plus headings", () => {
		assert.equal(parseJournalEvent(sessionEntry("a", { commentary: "y".repeat(4 * MAX_PART_CHARS + 600) })), null);
	});

	it("rejects facts above the stored size bound", () => {
		const facts = { kind: "review", blob: "z".repeat(17 * 1024) };
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), facts }), null);
	});

	it("rejects a week that is not a real calendar date", () => {
		const weekly = (weekOf: string) => ({
			id: debriefId(weeklyKey(weekOf)), kind: "weekly", sessionId: null, sessionKind: null, weekOf, at: "2026-11-06T09:00:00.000Z",
			facts: { kind: "weekly" }, commentary: "x", nullReason: null, author: "agent",
		});
		assert.equal(parseJournalEvent(weekly("2026-13-45")), null);
		assert.equal(parseJournalEvent(weekly("2026-02-30")), null);
		assert.notEqual(parseJournalEvent(weekly("2026-10-25")), null);
	});

	it("requires a date-time for `at`", () => {
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), at: "Nov 6 2026" }), null);
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), at: "2026-11-06" }), null);
	});

	it("rejects an id that is not the debrief id of its key", () => {
		assert.equal(parseJournalEvent({ ...sessionEntry("a"), id: "deb_000000000000" }), null);
	});

	it("rejects a session id that could be confused with a key (colons or odd characters)", () => {
		assert.equal(parseJournalEvent({ ...sessionEntry("weekly:2026-10-25"), id: debriefId("session:weekly:2026-10-25") }), null);
		assert.equal(parseJournalEvent({ ...sessionEntry("../x") }), null);
	});

	it("namespaces only the session keys that contain a colon", () => {
		assert.equal(sessionKey("chat_abc-1"), "chat_abc-1", "existing keys keep their form");
		assert.notEqual(sessionKey("weekly:2026-10-25"), weeklyKey("2026-10-25"));
		assert.equal(deriveJournal([sessionEntry("a", { commentary: "1" }), sessionEntry("a", { commentary: "2" })]).length, 1);
	});
});

describe("office hours windowing (item 10)", () => {
	const verdict = (at: string, stance: "matches" | "differs" | "missing", stepRef: string): OfficeHoursEvent => ({
		type: "verdict", chatId: "c", outcome: "differs", discarded: 0, at,
		items: [{ stepRef, sourceQuote: "q", workQuote: "w", stance }],
	});
	it("counts only the verdicts inside the session window", () => {
		const events: OfficeHoursEvent[] = [
			verdict("2026-11-06T08:00:00.000Z", "differs", "before"),
			verdict("2026-11-06T09:30:00.000Z", "differs", "inside"),
			verdict("2026-11-06T12:00:00.000Z", "missing", "after"),
		];
		const f = computeOfficeHoursFacts({
			chatId: "c", startedAt: "2026-11-06T09:00:00.000Z", endedAt: "2026-11-06T10:00:00.000Z",
			events, transcript: [] as TranscriptLine[],
		});
		assert.equal(f.verdicts.differs, 1);
		assert.equal(f.latestItems.differs, 1);
		assert.equal(f.stepsQuestioned, 1, "only the step questioned inside the window");
	});
});

describe("explicit end wins (decision 2026-11-06)", () => {
	const ref = (lastMin: number): SessionRef => ({
		sessionId: "a", kind: "review", title: "A",
		startedAt: new Date(NOW.getTime() - 120 * MIN).toISOString(),
		lastActivityAt: new Date(NOW.getTime() - lastMin * MIN).toISOString(),
	});
	const endAt = new Date(NOW.getTime() - 60 * MIN).toISOString();

	it("the explicit end is the session end, even when activity came after it", () => {
		assert.equal(endedAtOf(ref(10), NOW, DEFAULT_DEBRIEF_CONFIG.idleMs, endAt), endAt);
	});

	it("an explicit end before the start is clamped to the start", () => {
		assert.equal(endedAtOf(ref(10), NOW, DEFAULT_DEBRIEF_CONFIG.idleMs, "2000-01-01T00:00:00.000Z"), ref(10).startedAt);
	});

	it("pendingSessions sorts by the explicit end and ignores later activity", () => {
		const base = { journal: [], ends: new Map([["a", endAt]]), now: NOW, idleMs: DEFAULT_DEBRIEF_CONFIG.idleMs, lookbackMs: DEFAULT_DEBRIEF_CONFIG.lookbackMs };
		const [only] = pendingSessions({ ...base, refs: [ref(10)] });
		assert.equal(only?.endedAt, endAt);
	});
});

describe("sources: ids that the journal would not accept are left out (item 5)", () => {
	it("drops a chat whose id contains a colon", () => {
		const iso = "2026-11-06T09:00:00.000Z";
		const sources = createDebriefSources({
			chats: { list: () => [{ id: "weekly:2026-10-25", title: "x", kind: "review", createdAt: iso, updatedAt: iso }], messages: () => [] },
			reviewEvents: () => [], officeHoursEvents: () => [], exerciseEvents: () => [], cardEvents: () => [], goalEvents: () => [],
			activityEvents: () => [], journal: () => [], graph: () => ({ nodes: [], chains: [] }), lecture: () => null, trustLevels: () => new Map(),
			now: () => NOW, idleMs: DEFAULT_DEBRIEF_CONFIG.idleMs, budgetSec: DEFAULT_DEBRIEF_CONFIG.budgetSec,
		});
		assert.deepEqual(sources.sessions(), []);
	});
});

describe("writer: no provider call once the run is cancelled or the gate is closed (items 1, 4)", () => {
	const request = (): WriterRequest => ({
		kind: "session",
		title: "T",
		facts: { kind: "review", startedAt: "x", endedAt: "y", durationSec: 1, reviews: 1, perChannel: { fixed: 1, dialogic: 0 }, ratings: { "1": 0, "2": 0, "3": 1, "4": 0 }, lapses: 0, reviewSec: 1, budgetSec: 1, budgetRatio: 1, weakPremises: [] },
	});
	const countingEngine = () => {
		const calls = { n: 0 };
		const engine = { model: { id: "m", provider: "p", api: "a" }, streamFn: () => { calls.n++; throw new Error("no stream"); } } as unknown as PiEngine;
		return { engine, calls };
	};

	it("an already-aborted shared signal starts no provider call", async () => {
		const { engine, calls } = countingEngine();
		const shutdown = new AbortController();
		shutdown.abort();
		const writer = createDebriefWriter({ engine, priceCall: () => null, styleGuide: () => "S", signal: shutdown.signal });
		await assert.rejects(writer.write(request()), (e: unknown) => (e as { name?: string }).name === "AbortError");
		assert.equal(calls.n, 0);
	});

	it("a closed gate before the step starts no provider call", async () => {
		const { engine, calls } = countingEngine();
		const writer = createDebriefWriter({ engine, priceCall: () => null, styleGuide: () => "S" });
		const control = { onSpend: () => undefined, allowed: () => false, signal: new AbortController().signal };
		await assert.rejects(writer.write(request(), control));
		assert.equal(calls.n, 0);
	});
});

describe("service: spend is recorded once per billed step (item 1)", () => {
	function service(writeFn: (req: WriterRequest, control: Parameters<NonNullable<DebriefDeps["writer"]["write"]>>[1]) => Promise<{ commentary: Commentary; costUsd: number; styleVersion: string }>, gateRecord: (usd: number) => void) {
		const journal: JournalEvent[] = [];
		const activity: Array<{ type: "end"; sessionId: string; at: string }> = [];
		const sessionRef: SessionRef = { sessionId: "a", kind: "review", title: "A", startedAt: "2026-11-06T08:00:00.000Z", lastActivityAt: "2026-11-06T08:30:00.000Z" };
		const gate: CostGate = { allowed: () => true, record: (usd) => gateRecord(usd) };
		const reviewFacts = { kind: "review", startedAt: sessionRef.startedAt, endedAt: "x", durationSec: 1, reviews: 2, perChannel: { fixed: 2, dialogic: 0 }, ratings: { "1": 0, "2": 0, "3": 2, "4": 0 }, lapses: 0, reviewSec: 1, budgetSec: 1, budgetRatio: 0, weakPremises: [] } as const;
		const svc = createDebriefService({
			journal: { append: (e) => void journal.push(e), readAll: () => [...journal] },
			activity: { append: (e) => void activity.push(e as never), readAll: () => [...activity] },
			sources: {
				sessions: () => [sessionRef],
				sessionFacts: () => reviewFacts as never,
				weeklyFacts: () => { throw new Error("not used"); },
			},
			writer: { write: writeFn as never },
			gate,
			config: DEFAULT_DEBRIEF_CONFIG,
			lecture: () => null,
			now: () => NOW,
			clock: () => "2026-11-06T10:00:00.000Z",
			state: newDebriefState(),
		});
		return { svc, journal };
	}

	it("steps reported through onSpend are not recorded a second time from the total", async () => {
		const recorded: number[] = [];
		const { svc } = service(async (_req, control) => {
			control?.onSpend(0.02);
			control?.onSpend(0.03);
			return { commentary: ok, costUsd: 0.05, styleVersion: "v1" };
		}, (usd) => void recorded.push(usd));
		await svc.endSession("a");
		assert.deepEqual(recorded, [0.02, 0.03]);
	});

	it("a total the writer did not report step by step is recorded once", async () => {
		const recorded: number[] = [];
		const { svc } = service(async () => ({ commentary: ok, costUsd: 0.04, styleVersion: "v1" }), (usd) => void recorded.push(usd));
		await svc.endSession("a");
		assert.deepEqual(recorded, [0.04]);
	});

	it("a failed spend record stops the run and never causes a second paid call", async () => {
		let calls = 0;
		let allowedAfterFailure: boolean | undefined;
		const { svc, journal } = service(async (_req, control) => {
			calls++;
			try {
				control?.onSpend(0.02);
			} catch {
				// the service swallows its own failures
			}
			allowedAfterFailure = control?.allowed();
			return { commentary: ok, costUsd: 0.02, styleVersion: "v1" };
		}, () => {
			throw new Error("ledger locked");
		});
		await svc.endSession("a");
		assert.equal(allowedAfterFailure, false, "the run was not closed after the failed record");
		await svc.sweep();
		assert.equal(calls, 1);
		assert.equal(journal.length, 1);
		assert.equal(journal[0]?.commentary?.includes("Observations") ?? false, true, "the commentary obtained is kept");
	});
});

describe("prompt bounds (item 9)", () => {
	it("a fence is longer than any backtick run in the data", () => {
		const facts = { kind: "review", startedAt: "x", endedAt: "y", durationSec: 1, reviews: 1, perChannel: { fixed: 1, dialogic: 0 }, ratings: { "1": 0, "2": 0, "3": 1, "4": 0 }, lapses: 0, reviewSec: 1, budgetSec: 1, budgetRatio: 1, weakPremises: [{ nodeId: "n", name: "x````y", count: 1 }] };
		const prompt = buildDebriefPrompt({ kind: "session", title: "T", facts: facts as never });
		assert.ok(prompt.includes("x````y"));
		assert.ok(prompt.includes("`````json"), "the fence must be longer than the four-backtick run");
	});

	it("the facts block is cut at its bound with a marker", () => {
		const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "v".repeat(200)]));
		const block = factsBlock(many);
		assert.ok(block.length <= MAX_FACTS_BLOCK_CHARS + 40);
		assert.ok(block.endsWith("[facts truncated]"));
	});
});
