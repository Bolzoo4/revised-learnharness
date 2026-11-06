// src/core/ext/debrief/journal.ts
/**
 * @node ext/debrief/journal
 * journal.jsonl: one event per debrief (a session debrief or a weekly
 * synthesis). Facts and commentary are stored side by side so a reader can
 * check the remarks against the numbers (REQ-deb-05). Pure: types, parser,
 * derivation. A debrief is identified by its KEY (the session id, or
 * `weekly:<weekOf>`); the first event per key wins, so a duplicate line
 * (two server instances racing) can never create a second debrief
 * (REQ-deb-10).
 */

import { createHash } from "node:crypto";

export type SessionKind = "review" | "lecture" | "office_hours" | "study" | "exercises";
export const SESSION_KINDS: readonly SessionKind[] = ["review", "lecture", "office_hours", "study", "exercises"];

export type NullReason = "ceiling" | "error";

export interface JournalEvent {
	/** `deb_` plus the first 12 hex digits of the SHA-256 of the key. */
	id: string;
	kind: "session" | "weekly";
	/** Set for a session debrief. */
	sessionId: string | null;
	sessionKind: SessionKind | null;
	/** Set for a weekly synthesis: the local date (YYYY-MM-DD) the week's window starts. */
	weekOf: string | null;
	/** When the entry was written (ISO-8601). */
	at: string;
	/** The computed facts. The parser checks only that this is an object whose `kind` matches; the writer guarantees the rest. */
	facts: { kind: string; [key: string]: unknown };
	/** The agent's Markdown commentary, or null (daily ceiling reached, or the commentary failed repeatedly). */
	commentary: string | null;
	nullReason: NullReason | null;
	author: "agent";
}

const WEEK_OF = /^\d{4}-\d{2}-\d{2}$/;

export const sessionKey = (sessionId: string): string => sessionId;
export const weeklyKey = (weekOf: string): string => `weekly:${weekOf}`;
export const debriefId = (key: string): string => `deb_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

export function keyOf(e: Pick<JournalEvent, "kind" | "sessionId" | "weekOf">): string {
	return e.kind === "weekly" ? weeklyKey(e.weekOf ?? "") : sessionKey(e.sessionId ?? "");
}

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

export function parseJournalEvent(raw: unknown): JournalEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.id) || !isIso(r.at) || r.author !== "agent") return null;
	if (r.commentary !== null && !isStr(r.commentary)) return null;
	if (r.nullReason !== null && r.nullReason !== "ceiling" && r.nullReason !== "error") return null;
	// A commentary and a reason for its absence never coexist.
	if ((r.commentary === null) === (r.nullReason === null)) return null;
	const facts = r.facts;
	if (typeof facts !== "object" || facts === null || Array.isArray(facts) || !isStr((facts as { kind?: unknown }).kind)) return null;
	const factsKind = (facts as { kind: string }).kind;
	if (r.kind === "session") {
		if (!isStr(r.sessionId) || typeof r.sessionKind !== "string" || !SESSION_KINDS.includes(r.sessionKind as SessionKind)) return null;
		if (r.weekOf !== null || factsKind !== r.sessionKind) return null;
		return {
			id: r.id, kind: "session", sessionId: r.sessionId, sessionKind: r.sessionKind as SessionKind, weekOf: null, at: r.at,
			facts: facts as JournalEvent["facts"], commentary: r.commentary, nullReason: r.nullReason as NullReason | null, author: "agent",
		};
	}
	if (r.kind === "weekly") {
		if (!isStr(r.weekOf) || !WEEK_OF.test(r.weekOf) || r.sessionId !== null || r.sessionKind !== null || factsKind !== "weekly") return null;
		return {
			id: r.id, kind: "weekly", sessionId: null, sessionKind: null, weekOf: r.weekOf, at: r.at,
			facts: facts as JournalEvent["facts"], commentary: r.commentary, nullReason: r.nullReason as NullReason | null, author: "agent",
		};
	}
	return null;
}

/** The debriefs in append order, first event per key only (REQ-deb-10 at read time). */
export function deriveJournal(events: readonly JournalEvent[]): JournalEvent[] {
	const seen = new Set<string>();
	const out: JournalEvent[] = [];
	for (const e of events) {
		const key = keyOf(e);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}

export function findDebrief(journal: readonly JournalEvent[], key: string): JournalEvent | null {
	for (const e of journal) if (keyOf(e) === key) return e;
	return null;
}

export interface ListFilter {
	limit?: number;
	kind?: SessionKind | "weekly";
	/** ISO-8601; only entries written at or after it. An unparseable value is ignored. */
	since?: string;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** Newest first, bounded. A NaN, fractional or non-positive limit falls back to the default; a limit above the maximum is capped. */
export function recentDebriefs(journal: readonly JournalEvent[], filter: ListFilter = {}): { entries: JournalEvent[]; count: number; truncated: boolean } {
	const limit = Number.isInteger(filter.limit) && (filter.limit as number) > 0 ? Math.min(filter.limit as number, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
	const since = filter.since !== undefined ? Date.parse(filter.since) : Number.NaN;
	const matching = deriveJournal(journal)
		.filter((e) => (filter.kind === undefined ? true : filter.kind === "weekly" ? e.kind === "weekly" : e.sessionKind === filter.kind))
		.filter((e) => Number.isNaN(since) || Date.parse(e.at) >= since)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? -1 : 1));
	return { entries: matching.slice(0, limit), count: Math.min(matching.length, limit), truncated: matching.length > limit };
}
