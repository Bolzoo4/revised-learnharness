// tests/helpers/debrief-fakes.ts
/** Memory ports for the debrief service tests. */

import type { Commentary } from "../../src/core/ext/debrief/commentary.ts";
import type { ActivityEvent } from "../../src/core/ext/debrief/activity.ts";
import { DEFAULT_DEBRIEF_CONFIG } from "../../src/core/ext/debrief/config.ts";
import type { ReviewFacts } from "../../src/core/ext/debrief/facts.ts";
import type { JournalEvent } from "../../src/core/ext/debrief/journal.ts";
import type { DebriefSources, DebriefWriter, WriterRequest } from "../../src/core/ext/debrief/ports.ts";
import type { SessionRef } from "../../src/core/ext/debrief/sessions.ts";
import type { WeeklyFacts } from "../../src/core/ext/debrief/weekly.ts";
import { createDebriefService, newDebriefState, type DebriefDeps } from "../../src/server/ext/debrief-service.ts";
import { fakeGate } from "./ext-fakes.ts";

export const local = (m: number, d: number, h = 0, min = 0): Date => new Date(2026, m - 1, d, h, min);

export function memLedger<T>(initial: T[] = []): { events: T[]; append(e: T): void; readAll(): T[] } {
	const events = [...initial];
	return { events, append: (e) => void events.push(e), readAll: () => [...events] };
}

export const reviewFacts = (reviews = 3): ReviewFacts => ({
	kind: "review", startedAt: "2026-11-04T08:00:00.000Z", endedAt: "2026-11-04T09:00:00.000Z", durationSec: 3600, reviews,
	perChannel: { fixed: reviews, dialogic: 0 }, ratings: { "1": 0, "2": 0, "3": reviews, "4": 0 }, lapses: 0, reviewSec: 60, budgetSec: 1500, budgetRatio: 0.04, weakPremises: [],
});

export const weeklyFacts = (active = true): WeeklyFacts => ({
	kind: "weekly", weekOf: "2026-10-25", windowStart: "x", windowEnd: "y", budgetSec: 1500, days: [],
	backlog: { dueAtStart: 0, dueAtEnd: 0, trend: "flat" }, retention: { reviews: 0, recalled: 0, rate: null },
	goals: active ? [{ goalId: "g", title: "g", status: "active", total: 2, solidAtStart: 0, solidAtEnd: 0, delta: 0 }] : [],
	trust: { total: 0, sourced: 0, contested: 0, refuted: 0, unverified: 0 },
	sessions: { review: 0, lecture: 0, office_hours: 0, study: 0, exercises: 0 },
});

export const ref = (sessionId: string, lastActivity: Date, kind: SessionRef["kind"] = "review"): SessionRef => ({
	sessionId, kind, title: `Session ${sessionId}`, startedAt: new Date(lastActivity.getTime() - 20 * 60_000).toISOString(), lastActivityAt: lastActivity.toISOString(),
});

export interface FakeSources extends DebriefSources {
	refs: SessionRef[];
	factsOf: Map<string, () => ReturnType<DebriefSources["sessionFacts"]>>;
	weekly: () => WeeklyFacts;
	calls: { sessionFacts: number; weeklyFacts: number };
}

export function fakeSources(refs: SessionRef[] = []): FakeSources {
	const s: FakeSources = {
		refs,
		factsOf: new Map(),
		weekly: () => weeklyFacts(),
		calls: { sessionFacts: 0, weeklyFacts: 0 },
		sessions: () => [...s.refs],
		sessionFacts(r) {
			s.calls.sessionFacts += 1;
			return (s.factsOf.get(r.sessionId) ?? (() => reviewFacts()))();
		},
		weeklyFacts() {
			s.calls.weeklyFacts += 1;
			return s.weekly();
		},
	};
	return s;
}

export const goodCommentary: Commentary = { observations: "reviews = 3.", stateOfLearning: "Early days.", critique: "Short session.", suggestion: "Review the due items first." };

export interface FakeWriter extends DebriefWriter {
	calls: WriterRequest[];
	behaviour: () => Promise<{ commentary: Commentary; costUsd: number; styleVersion: string }>;
}

export function fakeWriter(): FakeWriter {
	const w: FakeWriter = {
		calls: [],
		behaviour: async () => ({ commentary: goodCommentary, costUsd: 0.05, styleVersion: "abc123abc123" }),
		write(request) {
			w.calls.push(request);
			return w.behaviour();
		},
	};
	return w;
}

export function harness(opts: { now?: Date; refs?: SessionRef[]; journal?: JournalEvent[]; activity?: ActivityEvent[]; lecture?: DebriefDeps["lecture"] } = {}) {
	const clock = { now: opts.now ?? local(11, 4, 12) };
	const journal = memLedger<JournalEvent>(opts.journal);
	const activity = memLedger<ActivityEvent>(opts.activity);
	const sources = fakeSources(opts.refs ?? []);
	const writer = fakeWriter();
	const gate = fakeGate(true);
	const service = createDebriefService({
		journal, activity, sources, writer, gate, config: DEFAULT_DEBRIEF_CONFIG, lecture: opts.lecture ?? (() => null),
		now: () => clock.now, clock: () => clock.now.toISOString(), state: newDebriefState(),
	});
	return { clock, journal, activity, sources, writer, gate, service };
}
