// src/server/ext/debrief-service.ts
/**
 * @node ext/debrief/service
 * The debrief use cases behind ports (REQ-deb-01, -02, -04 to -10): end a
 * session, sweep for ended sessions and the due week, list the history, and
 * record lecture playback. Writes ONLY the journal, the activity ledger and
 * the cost ledger (through the gate): it holds no goals, review or card
 * store, so a debrief cannot change them (REQ-deb-07).
 *
 * Idempotence (REQ-deb-10) has three layers: a lookup before work, a lookup
 * again just before the append (the model call takes time and another server
 * instance may have written), and first-event-wins when the journal is read.
 * Concurrent calls for one key share one in-flight promise, registered before
 * the writer runs, so a call made from inside the writer joins it instead of
 * paying again. Sweeps are single flight: a second caller joins the running one.
 *
 * Spend (REQ-deb-06) is recorded on the shared gate as each billed step
 * completes, also when the run then fails. A commentary that was obtained but
 * could not be stored is kept in memory and appended on the next sweep without
 * a model call.
 */

import { alreadyRecorded, ANY_SESSION_ID, explicitEnds, LECTURE_SESSION_ID, type ActivityEvent } from "../../core/ext/debrief/activity.ts";
import { renderCommentary } from "../../core/ext/debrief/commentary.ts";
import type { DebriefConfig } from "../../core/ext/debrief/config.ts";
import { hasSubstance } from "../../core/ext/debrief/facts.ts";
import {
	debriefId,
	deriveJournal,
	findDebrief,
	recentDebriefs,
	sessionKey,
	weeklyKey,
	type JournalEvent,
	type ListFilter,
} from "../../core/ext/debrief/journal.ts";
import { WriterUnavailableError, type DebriefSources, type DebriefWriter, type WriterControl, type WriterRequest } from "../../core/ext/debrief/ports.ts";
import { endedAtOf, pendingSessions, type SessionRef } from "../../core/ext/debrief/sessions.ts";
import { hasWeeklySubstance, weeklyWindow } from "../../core/ext/debrief/weekly.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { deriveLectureSessions } from "../../core/ext/debrief/activity.ts";
import { lectureNodeRefs, type Lecture } from "../../core/ext/lecture/lecture.ts";
import { HttpError } from "./http-error.ts";

/** A commentary that fails this many times in a row is stored as null (reason "error") rather than retried forever. */
export const MAX_COMMENTARY_ATTEMPTS = 3;
/** A sweep debriefs at most this many sessions; the rest wait for the next tick (bounds a burst of spend). */
export const MAX_PER_SWEEP = 5;
/** A writer call that has not answered after this long is cut off and counted as a failed attempt. */
export const WRITER_TIMEOUT_MS = 120_000;
/** Source label of the cost events (cost.jsonl). */
export const COST_SOURCE = "debrief";

export type DebriefOutcome =
	| { status: "created"; entry: JournalEvent }
	| { status: "exists"; entry: JournalEvent }
	/** The session or week had nothing to comment on: no entry. */
	| { status: "empty" }
	/** Not stored now: no model is configured, the commentary failed and will be retried, or the append failed and will be retried. */
	/** "provider-limit": a provider usage limit paused the work; nothing is stored, no attempt is used, the session stays pending. */
	| { status: "deferred"; reason: "unavailable" | "retry" | "provider-limit" };

export interface SweepResult {
	created: number;
	deferred: number;
	errors: number;
	weekly: DebriefOutcome["status"] | "error" | "not_due";
	/** True when a provider usage limit stopped the sweep before it finished. */
	providerLimited: boolean;
}

export interface DebriefState {
	inflight: Map<string, Promise<DebriefOutcome>>;
	failures: Map<string, number>;
	/** key -> signature of the last evaluation that found nothing to comment on (skips re-reading the ledgers every tick). */
	empty: Map<string, string>;
	/** key -> a commentary already paid for whose journal append failed: retried without a model call. */
	pending: Map<string, JournalEvent>;
	/** The running sweep, registered before its first step so a sweep started from inside it joins it. */
	sweep: Promise<SweepResult> | null;
}
export const newDebriefState = (): DebriefState => ({ inflight: new Map(), failures: new Map(), empty: new Map(), pending: new Map(), sweep: null });

export interface DebriefDeps {
	journal: { append(e: JournalEvent): void; readAll(): JournalEvent[] };
	activity: { append(e: ActivityEvent): void; readAll(): ActivityEvent[] };
	sources: DebriefSources;
	writer: DebriefWriter;
	gate: CostGate;
	config: DebriefConfig;
	lecture(id: string): Lecture | null;
	/** The sweep clock. The live wiring passes a function that scans every ledger (liveNow), so only sweeps and debrief timestamps use it. */
	now?: () => Date;
	/** The cheap clock that stamps activity and session ends (default: the system time). It never scans the ledgers. */
	clock?: () => string;
	/** Shared across module instances by the live wiring; tests get a fresh one. */
	state?: DebriefState;
	/** Upper bound of one writer call (default WRITER_TIMEOUT_MS). */
	writerTimeoutMs?: number;
}

const isAbortError = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
/** Races a writer call against a timer; on timeout the run is cancelled and the call fails. */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			onTimeout();
			reject(new Error("debrief writer call timed out"));
		}, ms);
	});
	try {
		return await Promise.race([work, limit]);
	} finally {
		clearTimeout(timer);
	}
}

const emptySweep = (): SweepResult => ({ created: 0, deferred: 0, errors: 0, weekly: "not_due", providerLimited: false });

export type LectureActivityInput =
	| { type: "lecture_view"; sessionId: string; lectureId: string; slideId: string }
	| { type: "concept_open"; sessionId: string; lectureId: string; nodeId: string }
	| { type: "exercise_done"; sessionId: string; lectureId: string; blockId: string };

export function createDebriefService(deps: DebriefDeps) {
	const now = deps.now ?? (() => new Date());
	const clock = deps.clock ?? (() => new Date().toISOString());
	const state = deps.state ?? newDebriefState();
	const journal = (): JournalEvent[] => deriveJournal(deps.journal.readAll());
	/** True while a provider usage limit (not the ceiling) closes the gate. */
	const providerLimited = (): boolean => {
		try {
			return deps.gate.reason?.() === "provider-limit";
		} catch {
			return false;
		}
	};

	/**
	 * Concurrent calls for one key share one run. The run is registered BEFORE it starts
	 * (it starts in a later microtask), so a call made from inside the run joins it.
	 */
	function once(key: string, run: () => Promise<DebriefOutcome>): Promise<DebriefOutcome> {
		const running = state.inflight.get(key);
		if (running) return running;
		const p = Promise.resolve()
			.then(run)
			.finally(() => state.inflight.delete(key));
		state.inflight.set(key, p);
		return p;
	}

	/** Stores an entry. A failed append keeps the entry for a retry without a model call; the caller sees "deferred", never the error. */
	function persist(key: string, entry: JournalEvent): DebriefOutcome {
		const already = findDebrief(journal(), key);
		state.pending.delete(key);
		if (already) return { status: "exists", entry: already };
		try {
			deps.journal.append(entry);
		} catch {
			state.pending.set(key, entry);
			console.error("[ext] debrief journal append failed; the entry is kept and retried without a model call");
			return { status: "deferred", reason: "retry" };
		}
		state.failures.delete(key);
		return { status: "created", entry };
	}

	async function finish(
		key: string,
		identity: Pick<JournalEvent, "kind" | "sessionId" | "sessionKind" | "weekOf">,
		request: WriterRequest,
	): Promise<DebriefOutcome> {
		let commentary: string | null = null;
		let nullReason: JournalEvent["nullReason"] = null;
		let styleVersion: string | undefined;
		// A provider limit stores nothing and uses no attempt: the session stays pending for a later sweep.
		if (providerLimited()) return { status: "deferred", reason: "provider-limit" };
		if (!deps.gate.allowed()) {
			nullReason = "ceiling"; // REQ-deb-06: facts are stored, the commentary is not attempted
		} else {
			const run = new AbortController();
			let reported = 0;
			let spendFailed = false;
			const recordSpend = (usd: number): void => {
				try {
					deps.gate.record(usd, COST_SOURCE);
				} catch {
					// The spend is unrecorded: stop the run and never pay for this session again.
					spendFailed = true;
					run.abort();
					console.error("[ext] debrief spend could not be recorded; the run is stopped");
				}
			};
			const control: WriterControl = {
				signal: run.signal,
				allowed: () => !run.signal.aborted && deps.gate.allowed(),
				onSpend(usd) {
					if (!(usd > 0) || !Number.isFinite(usd)) return;
					reported += usd;
					recordSpend(usd);
				},
			};
			try {
				const limit = deps.writerTimeoutMs ?? WRITER_TIMEOUT_MS;
				const written = await withTimeout(deps.writer.write(request, control), limit, () => run.abort());
				const rest = written.costUsd - reported; // what the writer did not report step by step
				if (rest > 1e-9) recordSpend(rest);
				commentary = renderCommentary(written.commentary);
				styleVersion = written.styleVersion;
			} catch (err) {
				if (err instanceof WriterUnavailableError) return { status: "deferred", reason: "unavailable" };
				if (spendFailed) nullReason = "error"; // paid, but unrecorded: never a second paid call
				else if (providerLimited()) return { status: "deferred", reason: "provider-limit" };
				else if (!deps.gate.allowed()) nullReason = "ceiling";
				else if (isAbortError(err)) return { status: "deferred", reason: "retry" }; // cancelled by shutdown: not a failure of the session
				else {
					console.error("[ext] debrief commentary failed"); // never returned to a client
					const attempts = (state.failures.get(key) ?? 0) + 1;
					state.failures.set(key, attempts);
					if (attempts < MAX_COMMENTARY_ATTEMPTS) return { status: "deferred", reason: "retry" };
					nullReason = "error";
				}
			}
		}
		const entry: JournalEvent = {
			id: debriefId(key),
			...identity,
			at: clock(),
			facts: request.facts as unknown as JournalEvent["facts"],
			commentary,
			nullReason,
			...(styleVersion !== undefined ? { styleVersion } : {}),
			author: "agent",
		};
		return persist(key, entry);
	}

	function debriefSession(ref: SessionRef, endedAt: string): Promise<DebriefOutcome> {
		const key = sessionKey(ref.sessionId);
		return once(key, async () => {
			const found = findDebrief(journal(), key);
			if (found) return { status: "exists", entry: found };
			const waiting = state.pending.get(key);
			if (waiting) return persist(key, waiting);
			const signature = `${ref.lastActivityAt}|${endedAt}`;
			if (state.empty.get(key) === signature) return { status: "empty" };
			const facts = deps.sources.sessionFacts(ref, endedAt);
			if (!hasSubstance(facts)) {
				state.empty.set(key, signature);
				return { status: "empty" };
			}
			return finish(key, { kind: "session", sessionId: ref.sessionId, sessionKind: ref.kind, weekOf: null }, { kind: "session", facts, title: ref.title });
		});
	}

	function debriefWeek(at: Date): Promise<DebriefOutcome | "not_due"> {
		const w = weeklyWindow(at, deps.config.weeklyDay, deps.config.weeklyHour);
		const key = weeklyKey(w.weekOf);
		if (findDebrief(journal(), key)) return Promise.resolve("not_due");
		return once(key, async () => {
			const found = findDebrief(journal(), key);
			if (found) return { status: "exists", entry: found };
			const waiting = state.pending.get(key);
			if (waiting) return persist(key, waiting);
			if (state.empty.get(key) === w.end) return { status: "empty" };
			const facts = deps.sources.weeklyFacts(w);
			if (!hasWeeklySubstance(facts)) {
				state.empty.set(key, w.end);
				return { status: "empty" };
			}
			return finish(key, { kind: "weekly", sessionId: null, sessionKind: null, weekOf: w.weekOf }, { kind: "weekly", facts });
		});
	}

	function sweepNow(): Promise<SweepResult> {
		if (state.sweep) return state.sweep; // single flight: a second caller joins the first
		// The run starts in a later microtask, after it is registered: a sweep started from inside the writer joins it.
		const run = Promise.resolve()
			.then(async (): Promise<SweepResult> => {
			const result = emptySweep();
			const at = now();
			for (const [key, entry] of [...state.pending]) {
				if (persist(key, entry).status === "created") result.created += 1; // paid appends first, no model call
			}
			if (providerLimited()) {
				// Nothing is started while the provider is paused; the sessions and the week stay pending.
				result.providerLimited = true;
				return result;
			}
			const pending = pendingSessions({
				refs: deps.sources.sessions(),
				journal: journal(),
				ends: explicitEnds(deps.activity.readAll()),
				now: at,
				idleMs: deps.config.idleMs,
				lookbackMs: deps.config.lookbackMs,
			}).slice(0, MAX_PER_SWEEP);
			for (const p of pending) {
				try {
					const out = await debriefSession(p.ref, p.endedAt);
					if (out.status === "created") result.created += 1;
					else if (out.status === "deferred") result.deferred += 1;
					if (out.status === "deferred" && out.reason === "provider-limit") {
						result.providerLimited = true;
						return result; // the rest wait for the pause to end
					}
				} catch {
					result.errors += 1; // one broken session never blocks the others
					console.error("[ext] debrief of one session failed");
				}
			}
			try {
				const out = await debriefWeek(at);
				result.weekly = out === "not_due" ? out : out.status;
				if (out !== "not_due" && out.status === "deferred" && out.reason === "provider-limit") result.providerLimited = true;
				if (out !== "not_due" && out.status === "created") result.created += 1;
				if (out !== "not_due" && out.status === "deferred") result.deferred += 1;
			} catch {
				result.weekly = "error";
				result.errors += 1;
				console.error("[ext] weekly synthesis failed");
			}
			return result;
			})
			.finally(() => {
				state.sweep = null;
			});
		state.sweep = run;
		return run;
	}

	async function endSession(sessionId: string): Promise<DebriefOutcome> {
		if (typeof sessionId !== "string" || !ANY_SESSION_ID.test(sessionId)) throw new HttpError(400, "invalid session id");
		const ref = deps.sources.sessions().find((r) => r.sessionId === sessionId);
		if (!ref) throw new HttpError(404, "unknown session");
		const existing = findDebrief(journal(), sessionKey(sessionId));
		if (existing) return { status: "exists", entry: existing };
		const ends = explicitEnds(deps.activity.readAll());
		let end = ends.get(sessionId);
		if (end === undefined) {
			end = clock();
			deps.activity.append({ type: "end", sessionId, at: end });
		}
		const endedAt = endedAtOf(ref, new Date(clock()), deps.config.idleMs, end) ?? end;
		return debriefSession(ref, endedAt);
	}

	function list(filter: ListFilter = {}) {
		return recentDebriefs(deps.journal.readAll(), filter);
	}

	function get(id: string): JournalEvent {
		const found = typeof id === "string" ? journal().find((e) => e.id === id) : undefined;
		if (!found) throw new HttpError(404, "unknown debrief");
		return found;
	}

	/** Sessions still running (not ended, no debrief), newest activity first, bounded. */
	function openSessions(limit = 50) {
		const at = now();
		const ends = explicitEnds(deps.activity.readAll());
		const done = journal();
		return deps.sources
			.sessions()
			.filter((r) => findDebrief(done, sessionKey(r.sessionId)) === null && endedAtOf(r, at, deps.config.idleMs, ends.get(r.sessionId)) === null)
			.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
			.slice(0, limit)
			.map((r) => ({ sessionId: r.sessionId, kind: r.kind, title: r.title, lastActivityAt: r.lastActivityAt }));
	}

	function recordLectureActivity(input: LectureActivityInput): { recorded: boolean } {
		if (!LECTURE_SESSION_ID.test(input.sessionId)) throw new HttpError(400, "invalid lecture session id");
		const lecture = deps.lecture(input.lectureId);
		if (!lecture) throw new HttpError(404, "unknown lecture");
		if (input.type === "lecture_view" && !lecture.slides.some((s) => s.id === input.slideId)) throw new HttpError(400, "unknown slide");
		if (input.type === "exercise_done" && !lecture.blocks.some((b) => b.id === input.blockId && b.role === "exercise")) throw new HttpError(400, "unknown exercise");
		if (input.type === "concept_open" && !lectureNodeRefs(lecture).includes(input.nodeId)) throw new HttpError(400, "the lecture does not cite this concept");
		const events = deps.activity.readAll();
		const session = deriveLectureSessions(events).find((s) => s.sessionId === input.sessionId);
		if (session && session.lectureId !== input.lectureId) throw new HttpError(409, "this session belongs to another lecture");
		if (explicitEnds(events).has(input.sessionId) || findDebrief(journal(), sessionKey(input.sessionId))) throw new HttpError(409, "this session has ended; start a new one");
		const event = { ...input, at: clock() } as Exclude<ActivityEvent, { type: "end" }>;
		if (alreadyRecorded(events, event)) return { recorded: false };
		deps.activity.append(event);
		return { recorded: true };
	}

	return { endSession, sweep: sweepNow, list, get, openSessions, recordLectureActivity };
}

export type DebriefService = ReturnType<typeof createDebriefService>;
