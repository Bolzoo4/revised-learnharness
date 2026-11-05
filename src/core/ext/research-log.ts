// src/core/ext/research-log.ts
/**
 * research-log.jsonl (REQ-rs-10): one entry per cycle with the gaps chosen,
 * questions, sources, nodes added, confidence with rationale, and cost.
 * Also the derivations that read it: the budget spent per mark and the time of
 * the last cycle. Pure.
 */

import type { GapType } from "./research-config.ts";

/** `skipped-active`: an active library source met in a source hunt (verification already uses it). */
export type SourceOutcome = "ingested" | "inbox" | "skipped-rejected" | "skipped-seen" | "skipped-active" | "not-fetched" | "not-capturable" | "over-cap" | "failed";

export interface SourceLog {
	locator: string;
	outcome: SourceOutcome;
	nodesAdded: number;
}

export type GapStop = "confidence" | "no-more-sources" | "turn-limit";

export interface GapLog {
	gapId: string;
	type: GapType;
	nodeId?: string;
	chatId?: string;
	/** The mark governing the gap when it ran (budgets are summed per mark). */
	markId?: string;
	questions: string[];
	confidence?: number;
	rationale?: string;
	stoppedBy?: GapStop;
	sources: SourceLog[];
	nodesAdded: number;
	costUsd: number;
	/** True when this gap set its node to `hold` ("saturated"). */
	saturated: boolean;
	error?: string;
}

export interface CycleLogEntry {
	type: "cycle";
	cycleId: string;
	trigger: "schedule" | "manual";
	startedAt: string;
	endedAt: string;
	stoppedBy: "completed" | "no-gaps" | "ceiling" | "aborted" | "error";
	gaps: GapLog[];
	watch: { entries: number; items: number; ingested: number; inbox: number };
	nodesAdded: number;
	costUsd: number;
	/** Steering messages the user sent while the cycle ran. */
	steers: string[];
}

const GAP_TYPES = new Set<string>(["uncovered", "no-premises", "weak-premise", "unverified", "contested-no-primary"]);
const STOPS = new Set<string>(["completed", "no-gaps", "ceiling", "aborted", "error"]);
const GAP_STOPS = new Set<string>(["confidence", "no-more-sources", "turn-limit"]);
const OUTCOMES = new Set<string>(["ingested", "inbox", "skipped-rejected", "skipped-seen", "skipped-active", "not-fetched", "not-capturable", "over-cap", "failed"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
/** A count: a finite integer >= 0 (NaN, Infinity, negatives and fractions are rejected). */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** An amount of money: finite and >= 0. */
const isUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function parseSource(s: unknown): SourceLog | null {
	if (!isObj(s) || !isNonEmpty(s.locator) || !isStr(s.outcome) || !OUTCOMES.has(s.outcome) || !isCount(s.nodesAdded)) return null;
	return { locator: s.locator, outcome: s.outcome as SourceOutcome, nodesAdded: s.nodesAdded };
}

function parseGap(g: unknown): GapLog | null {
	if (!isObj(g)) return null;
	if (!isNonEmpty(g.gapId) || !isStr(g.type) || !GAP_TYPES.has(g.type)) return null;
	if (!isStrArray(g.questions) || !Array.isArray(g.sources)) return null;
	const sources: SourceLog[] = [];
	for (const s of g.sources) {
		const p = parseSource(s);
		if (p === null) return null;
		sources.push(p);
	}
	if (!isCount(g.nodesAdded) || !isUsd(g.costUsd) || typeof g.saturated !== "boolean") return null;
	const out: GapLog = {
		gapId: g.gapId,
		type: g.type as GapType,
		questions: g.questions,
		sources,
		nodesAdded: g.nodesAdded,
		costUsd: g.costUsd,
		saturated: g.saturated,
	};
	// markId and costUsd drive the budget, so a bad one rejects the entry. The rest is
	// informational: an invalid value is dropped so the cost it sits next to is not lost.
	if (g.markId !== undefined) {
		if (!isStr(g.markId)) return null;
		out.markId = g.markId;
	}
	for (const key of ["nodeId", "chatId", "rationale", "error"] as const) {
		if (isStr(g[key])) out[key] = g[key];
	}
	if (typeof g.confidence === "number" && g.confidence >= 0 && g.confidence <= 1) out.confidence = g.confidence;
	if (isStr(g.stoppedBy) && GAP_STOPS.has(g.stoppedBy)) out.stoppedBy = g.stoppedBy as GapStop;
	return out;
}

/**
 * Validates a log line; returns a clean copy (unknown keys and invalid optional
 * fields dropped) or null. Strict only where the budget depends on it: cycleId,
 * parseable start/end times (their order is not checked), counts, costUsd and markId.
 */
export function parseCycleLogEntry(raw: unknown): CycleLogEntry | null {
	if (!isObj(raw) || raw.type !== "cycle") return null;
	if (!isNonEmpty(raw.cycleId)) return null;
	if (raw.trigger !== "schedule" && raw.trigger !== "manual") return null;
	if (!isDate(raw.startedAt) || !isDate(raw.endedAt)) return null;
	if (!isStr(raw.stoppedBy) || !STOPS.has(raw.stoppedBy)) return null;
	if (!Array.isArray(raw.gaps)) return null;
	const gaps: GapLog[] = [];
	for (const g of raw.gaps) {
		const p = parseGap(g);
		if (p === null) return null;
		gaps.push(p);
	}
	const w = raw.watch;
	if (!isObj(w) || !isCount(w.entries) || !isCount(w.items) || !isCount(w.ingested) || !isCount(w.inbox)) return null;
	if (!isCount(raw.nodesAdded) || !isUsd(raw.costUsd) || !isStrArray(raw.steers)) return null;
	return {
		type: "cycle",
		cycleId: raw.cycleId,
		trigger: raw.trigger,
		startedAt: raw.startedAt,
		endedAt: raw.endedAt,
		stoppedBy: raw.stoppedBy as CycleLogEntry["stoppedBy"],
		gaps,
		watch: { entries: w.entries, items: w.items, ingested: w.ingested, inbox: w.inbox },
		nodesAdded: raw.nodesAdded,
		costUsd: raw.costUsd,
		steers: raw.steers,
	};
}

/** USD spent per mark id: the sum of the cost of every gap that ran under that mark. */
export function markSpendUsd(log: readonly CycleLogEntry[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const entry of log) {
		for (const gap of entry.gaps) {
			// isFinite is redundant for parsed entries; kept because callers may pass hand-built ones and NaN would poison the sum.
			if (gap.markId === undefined || !Number.isFinite(gap.costUsd)) continue;
			out.set(gap.markId, (out.get(gap.markId) ?? 0) + gap.costUsd);
		}
	}
	return out;
}

/** End time (as logged) of the most recent cycle by instant, not by string; null when none ran or no end time parses. A tie keeps the first. */
export function lastCycleEndedAt(log: readonly CycleLogEntry[]): string | null {
	let last: string | null = null;
	let lastMs = Number.NEGATIVE_INFINITY;
	for (const e of log) {
		const ms = Date.parse(e.endedAt);
		if (Number.isNaN(ms) || ms <= lastMs) continue;
		last = e.endedAt;
		lastMs = ms;
	}
	return last;
}

/**
 * A scheduled cycle is due when none ran yet or the last ended at least `cycleHours` ago.
 * Fail closed: an unparseable `nowIso`, a `cycleHours` that is not a finite number > 0, or a
 * log whose end times all fail to parse is never due (a broken clock, config or log must not
 * start paid work). A cycle that "ended" after `nowIso` (clock skew, corrupt date) is ignored,
 * so it can neither hide a recent cycle nor postpone the next one indefinitely.
 */
export function cycleDue(log: readonly CycleLogEntry[], nowIso: string, cycleHours: number): boolean {
	const now = Date.parse(nowIso);
	if (Number.isNaN(now) || !Number.isFinite(cycleHours) || cycleHours <= 0) return false;
	if (log.length === 0) return true;
	let last = Number.NEGATIVE_INFINITY;
	let parseable = 0;
	for (const e of log) {
		const ms = Date.parse(e.endedAt);
		if (Number.isNaN(ms)) continue;
		parseable++;
		if (ms <= now && ms > last) last = ms;
	}
	if (parseable === 0) return false;
	return now - last >= cycleHours * 3_600_000;
}
