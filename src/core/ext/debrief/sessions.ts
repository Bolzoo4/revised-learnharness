// src/core/ext/debrief/sessions.ts
/**
 * @node ext/debrief/sessions
 * Which sessions exist, which have ended and which still need a debrief.
 * The extension never changes upstream's chat lifecycle (there is no "end"
 * in it): a session ends when the user ends it (an `end` event in
 * activity.jsonl) or after `idleMs` without activity (REQ-deb-01).
 */

import { findDebrief, sessionKey, type JournalEvent, type SessionKind } from "./journal.ts";

export interface SessionRef {
	/** Unique across kinds: a chat id, an exercise set id or a lecture session id. */
	sessionId: string;
	kind: SessionKind;
	title: string;
	startedAt: string;
	lastActivityAt: string;
}

const ms = (iso: string): number => Date.parse(iso);

/**
 * When the session ended, or null while it is still open.
 * - An explicit end WINS: it is the session end, clamped to not precede the
 *   start. Activity after an explicit end is ignored for that session.
 * - Otherwise the session ended at its last activity once `idleMs` has passed since.
 * An unparseable timestamp never ends a session (it stays open and out of the sweep).
 */
export function endedAtOf(ref: SessionRef, now: Date, idleMs: number, explicitEnd: string | undefined): string | null {
	const start = ms(ref.startedAt);
	const last = ms(ref.lastActivityAt);
	if (Number.isNaN(start) || Number.isNaN(last)) return null;
	if (explicitEnd !== undefined) {
		const end = ms(explicitEnd);
		if (!Number.isNaN(end)) return new Date(Math.max(end, start)).toISOString();
	}
	if (!(idleMs > 0) || !Number.isFinite(idleMs)) return null;
	if (now.getTime() - last >= idleMs) return new Date(Math.max(last, start)).toISOString();
	return null;
}

export interface PendingSession {
	ref: SessionRef;
	endedAt: string;
}

/**
 * Ended sessions without a debrief and recent enough to deserve one, oldest
 * end first. A session id listed twice counts once (the first listing wins).
 * The lookback applies to explicitly ended sessions too (config: sessions
 * whose last activity is older than the lookback are never debriefed by the sweep).
 * The journal is matched by the session's KEY, so a session id that looks like
 * a weekly key is never confused with that week.
 */
export function pendingSessions(input: {
	refs: readonly SessionRef[];
	journal: readonly JournalEvent[];
	ends: ReadonlyMap<string, string>;
	now: Date;
	idleMs: number;
	lookbackMs: number;
}): PendingSession[] {
	const seen = new Set<string>();
	const out: PendingSession[] = [];
	for (const ref of input.refs) {
		if (seen.has(ref.sessionId)) continue;
		seen.add(ref.sessionId);
		if (findDebrief(input.journal, sessionKey(ref.sessionId)) !== null) continue;
		const endedAt = endedAtOf(ref, input.now, input.idleMs, input.ends.get(ref.sessionId));
		if (endedAt === null) continue;
		if (input.now.getTime() - ms(ref.lastActivityAt) > input.lookbackMs) continue;
		out.push({ ref, endedAt });
	}
	return out.sort((a, b) => ms(a.endedAt) - ms(b.endedAt) || (a.ref.sessionId < b.ref.sessionId ? -1 : 1));
}

export interface Window {
	sessionId: string;
	startedAt: string;
	endedAt: string;
}

/**
 * Review events carry no session id, so they are attributed by time: an event
 * belongs to the window that contains it and started LAST (ties: the smaller
 * session id). Two overlapping review sessions therefore never count the same
 * review twice.
 */
export function ownerOfEvent(at: string, windows: readonly Window[]): string | null {
	const t = ms(at);
	if (Number.isNaN(t)) return null;
	let best: Window | null = null;
	for (const w of windows) {
		const s = ms(w.startedAt);
		const e = ms(w.endedAt);
		if (Number.isNaN(s) || Number.isNaN(e) || t < s || t > e) continue;
		if (best === null || s > ms(best.startedAt) || (s === ms(best.startedAt) && w.sessionId < best.sessionId)) best = w;
	}
	return best?.sessionId ?? null;
}
