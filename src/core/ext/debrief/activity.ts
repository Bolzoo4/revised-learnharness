/**
 * @node ext/debrief/activity
 * activity.jsonl: what the extension cannot derive from another ledger.
 * Lecture playback leaves no other trace, so the player reports slides
 * viewed, concepts opened and in-lecture exercises done under a lecture
 * session id; and any session can be ended explicitly (`end`). Pure: types,
 * parser, derivations.
 */

export type ActivityEvent =
	| { type: "lecture_view"; sessionId: string; lectureId: string; slideId: string; at: string }
	| { type: "concept_open"; sessionId: string; lectureId: string; nodeId: string; at: string }
	| { type: "exercise_done"; sessionId: string; lectureId: string; blockId: string; at: string }
	| { type: "end"; sessionId: string; at: string };

/** A lecture session id is minted by the player. */
export const LECTURE_SESSION_ID = /^lecs_[A-Za-z0-9]{8,32}$/;
/** Any session id (a chat id, a set id, a lecture session id). */
export const ANY_SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TARGET_MAX = 200;

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isTarget = (v: unknown): v is string => isStr(v) && v.length <= TARGET_MAX;

export function parseActivityEvent(raw: unknown): ActivityEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.sessionId) || !ANY_SESSION_ID.test(r.sessionId) || !isStr(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "end") return { type: "end", sessionId: r.sessionId, at: r.at };
	if (!LECTURE_SESSION_ID.test(r.sessionId) || !isTarget(r.lectureId)) return null;
	if (r.type === "lecture_view" && isTarget(r.slideId)) return { type: "lecture_view", sessionId: r.sessionId, lectureId: r.lectureId, slideId: r.slideId, at: r.at };
	if (r.type === "concept_open" && isTarget(r.nodeId)) return { type: "concept_open", sessionId: r.sessionId, lectureId: r.lectureId, nodeId: r.nodeId, at: r.at };
	if (r.type === "exercise_done" && isTarget(r.blockId)) return { type: "exercise_done", sessionId: r.sessionId, lectureId: r.lectureId, blockId: r.blockId, at: r.at };
	return null;
}

export interface LectureSessionState {
	sessionId: string;
	lectureId: string;
	startedAt: string;
	lastActivityAt: string;
	slides: Set<string>;
	concepts: Set<string>;
	exercises: Set<string>;
}

/** Lecture sessions in order of first event. The first event of a session fixes its lecture; later events naming another lecture are ignored. */
export function deriveLectureSessions(events: readonly ActivityEvent[]): LectureSessionState[] {
	const sessions = new Map<string, LectureSessionState>();
	for (const e of events) {
		if (e.type === "end") continue;
		let s = sessions.get(e.sessionId);
		if (s === undefined) {
			s = { sessionId: e.sessionId, lectureId: e.lectureId, startedAt: e.at, lastActivityAt: e.at, slides: new Set(), concepts: new Set(), exercises: new Set() };
			sessions.set(e.sessionId, s);
		}
		if (s.lectureId !== e.lectureId) continue;
		if (Date.parse(e.at) < Date.parse(s.startedAt)) s.startedAt = e.at;
		if (Date.parse(e.at) > Date.parse(s.lastActivityAt)) s.lastActivityAt = e.at;
		if (e.type === "lecture_view") s.slides.add(e.slideId);
		else if (e.type === "concept_open") s.concepts.add(e.nodeId);
		else s.exercises.add(e.blockId);
	}
	return [...sessions.values()];
}

/** Explicit ends: the EARLIEST `end` per session wins. */
export function explicitEnds(events: readonly ActivityEvent[]): Map<string, string> {
	const ends = new Map<string, string>();
	for (const e of events) {
		if (e.type !== "end") continue;
		const prev = ends.get(e.sessionId);
		if (prev === undefined || Date.parse(e.at) < Date.parse(prev)) ends.set(e.sessionId, e.at);
	}
	return ends;
}

/** True when the same lecture event is already recorded (the player may repeat itself; the ledger must not grow with it). */
export function alreadyRecorded(events: readonly ActivityEvent[], candidate: Exclude<ActivityEvent, { type: "end" }>): boolean {
	return events.some((e) => {
		if (e.type === "end" || e.sessionId !== candidate.sessionId || e.lectureId !== candidate.lectureId) return false;
		if (e.type === "lecture_view" && candidate.type === "lecture_view") return e.slideId === candidate.slideId;
		if (e.type === "concept_open" && candidate.type === "concept_open") return e.nodeId === candidate.nodeId;
		if (e.type === "exercise_done" && candidate.type === "exercise_done") return e.blockId === candidate.blockId;
		return false;
	});
}
