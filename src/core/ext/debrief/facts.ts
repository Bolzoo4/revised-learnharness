// src/core/ext/debrief/facts.ts
/**
 * @node ext/debrief/facts
 * Session facts (REQ-deb-03): a PURE, deterministic function of the ledgers'
 * contents, per session kind, with no model and no clock. Every number the
 * agent may cite comes from here. Inputs are plain data so the same function
 * serves the app and a later rewrite (REQ-deb-11).
 */

import type { ExerciseSetState } from "../practice/exercises.ts";
import type { OfficeHoursEvent } from "../practice/office-hours.ts";
import type { ReviewEvent } from "../review.ts";
import type { SessionKind } from "./journal.ts";

export interface TranscriptLine {
	role: "user" | "assistant";
	/** Epoch milliseconds (LhMessage.timestamp). */
	at: number;
	text: string;
}

interface Span {
	startedAt: string;
	endedAt: string;
}

/** Whole seconds between two instants; 0 when unparseable or reversed. */
export function spanSec(startedAt: string, endedAt: string): number {
	const d = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
	return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
}

const inWindow = (at: string | number, w: Span): boolean => {
	const t = typeof at === "number" ? at : Date.parse(at);
	return Number.isFinite(t) && t >= Date.parse(w.startedAt) && t <= Date.parse(w.endedAt);
};

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ── review ──────────────────────────────────────────────────────────────────

export interface ReviewFacts {
	kind: "review";
	startedAt: string;
	endedAt: string;
	durationSec: number;
	reviews: number;
	perChannel: { fixed: number; dialogic: number };
	ratings: { "1": number; "2": number; "3": number; "4": number };
	/** Reviews rated Again. */
	lapses: number;
	reviewSec: number;
	budgetSec: number;
	/** reviewSec / budgetSec, 3 decimals; null when the budget is not positive. */
	budgetRatio: number | null;
	/** Premises the dialogue found weak, most often first (at most 10). */
	weakPremises: Array<{ nodeId: string; name: string; count: number }>;
}

export function computeReviewFacts(input: {
	startedAt: string;
	endedAt: string;
	events: readonly ReviewEvent[];
	/** Does this instant belong to this session (see ownerOfEvent)? */
	owns: (at: string) => boolean;
	/** Existing nodes only: events about any other node are ignored (REQ-review-01). */
	names: ReadonlyMap<string, string>;
	budgetSec: number;
}): ReviewFacts {
	const ratings = { "1": 0, "2": 0, "3": 0, "4": 0 };
	const perChannel = { fixed: 0, dialogic: 0 };
	const weak = new Map<string, number>();
	let reviews = 0;
	let reviewSec = 0;
	for (const e of input.events) {
		if (e.type !== "review" || e.channel === "exercise") continue;
		if (!input.names.has(e.nodeId) || !inWindow(e.at, input) || !input.owns(e.at)) continue;
		reviews += 1;
		perChannel[e.channel] += 1;
		ratings[String(e.rating) as keyof typeof ratings] += 1;
		reviewSec += e.durationSec;
		for (const id of new Set(e.weakPremises ?? [])) if (input.names.has(id)) weak.set(id, (weak.get(id) ?? 0) + 1);
	}
	const budget = Number.isFinite(input.budgetSec) && input.budgetSec > 0 ? input.budgetSec : 0;
	return {
		kind: "review",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationSec: spanSec(input.startedAt, input.endedAt),
		reviews,
		perChannel,
		ratings,
		lapses: ratings["1"],
		reviewSec: Math.round(reviewSec),
		budgetSec: budget,
		budgetRatio: budget > 0 ? round3(reviewSec / budget) : null,
		weakPremises: [...weak.entries()]
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, 10)
			.map(([nodeId, count]) => ({ nodeId, name: input.names.get(nodeId) ?? nodeId, count })),
	};
}

// ── lecture ─────────────────────────────────────────────────────────────────

export interface LectureFacts {
	kind: "lecture";
	startedAt: string;
	endedAt: string;
	durationSec: number;
	lectureId: string;
	title: string | null;
	slidesViewed: number;
	/** null when the lecture no longer exists. */
	slidesTotal: number | null;
	conceptsOpened: number;
	exercisesDone: number;
	exercisesTotal: number | null;
}

export function computeLectureFacts(input: {
	startedAt: string;
	endedAt: string;
	lectureId: string;
	lecture: { title: string; slideIds: readonly string[]; exerciseBlockIds: readonly string[] } | null;
	slides: ReadonlySet<string>;
	concepts: ReadonlySet<string>;
	exercises: ReadonlySet<string>;
}): LectureFacts {
	const l = input.lecture;
	const slideSet = l ? new Set(l.slideIds) : null;
	const exSet = l ? new Set(l.exerciseBlockIds) : null;
	return {
		kind: "lecture",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationSec: spanSec(input.startedAt, input.endedAt),
		lectureId: input.lectureId,
		title: l?.title ?? null,
		slidesViewed: slideSet ? [...input.slides].filter((s) => slideSet.has(s)).length : input.slides.size,
		slidesTotal: slideSet ? slideSet.size : null,
		conceptsOpened: input.concepts.size,
		exercisesDone: exSet ? [...input.exercises].filter((b) => exSet.has(b)).length : input.exercises.size,
		exercisesTotal: exSet ? exSet.size : null,
	};
}

// ── office hours ────────────────────────────────────────────────────────────

export interface OfficeHoursFacts {
	kind: "office_hours";
	startedAt: string;
	endedAt: string;
	durationSec: number;
	designatedSource: string | null;
	verdicts: { consistent: number; differs: number; not_verifiable: number };
	/** Items of the LATEST verdict, by stance. */
	latestItems: { matches: number; differs: number; missing: number };
	/** Distinct steps the verdicts questioned (stance differs or missing), across all verdicts. */
	stepsQuestioned: number;
	learnerMessages: number;
	/** Questions of the tutor with no learner message before the tutor spoke again (or the session ended). */
	unansweredQuestions: number;
}

/** Assistant lines ending in a question mark that the learner never answered. */
export function countUnanswered(lines: readonly TranscriptLine[]): number {
	let open = 0;
	let pending = false;
	for (const line of lines) {
		if (line.role === "assistant") {
			if (pending) open += 1;
			pending = /\?["')\]*_\s]*$/.test(line.text.trim());
		} else if (line.text.trim() !== "") {
			pending = false;
		}
	}
	return pending ? open + 1 : open;
}

export function computeOfficeHoursFacts(input: {
	chatId: string;
	startedAt: string;
	endedAt: string;
	events: readonly OfficeHoursEvent[];
	transcript: readonly TranscriptLine[];
}): OfficeHoursFacts {
	const w = input;
	const mine = input.events.filter((e) => e.chatId === input.chatId);
	let designated: string | null = null;
	const verdicts = { consistent: 0, differs: 0, not_verifiable: 0 };
	const questioned = new Set<string>();
	let latest = { matches: 0, differs: 0, missing: 0 };
	for (const e of mine) {
		if (e.type === "designated") designated = e.label;
		else {
			verdicts[e.outcome] += 1;
			latest = { matches: 0, differs: 0, missing: 0 };
			for (const item of e.items) {
				latest[item.stance] += 1;
				if (item.stance !== "matches") questioned.add(item.stepRef);
			}
		}
	}
	const lines = input.transcript.filter((l) => inWindow(l.at, w));
	return {
		kind: "office_hours",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationSec: spanSec(input.startedAt, input.endedAt),
		designatedSource: designated,
		verdicts,
		latestItems: latest,
		stepsQuestioned: questioned.size,
		learnerMessages: lines.filter((l) => l.role === "user" && l.text.trim() !== "").length,
		unansweredQuestions: countUnanswered(lines),
	};
}

// ── exercises ───────────────────────────────────────────────────────────────

export interface ExerciseFacts {
	kind: "exercises";
	startedAt: string;
	endedAt: string;
	durationSec: number;
	setId: string;
	goalId: string;
	exercisesTotal: number;
	exercisesGraded: number;
	/** Outcome per node: the worst across the set's latest gradings. */
	nodes: Array<{ nodeId: string; name: string; outcome: "passed" | "weak" | "failed" }>;
	lowConfidenceGradings: number;
	applied: boolean;
	goalReached: boolean;
}

export function computeExerciseFacts(input: {
	set: ExerciseSetState;
	startedAt: string;
	endedAt: string;
	names: ReadonlyMap<string, string>;
}): ExerciseFacts {
	const rank = { passed: 0, weak: 1, failed: 2 } as const;
	const worst = new Map<string, keyof typeof rank>();
	let low = 0;
	for (const g of input.set.graded.values()) {
		if (g.lowConfidence) low += 1;
		for (const o of g.nodeOutcomes) {
			const prev = worst.get(o.nodeId);
			if (prev === undefined || rank[o.outcome] > rank[prev]) worst.set(o.nodeId, o.outcome);
		}
	}
	return {
		kind: "exercises",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationSec: spanSec(input.startedAt, input.endedAt),
		setId: input.set.setId,
		goalId: input.set.goalId,
		exercisesTotal: input.set.exercises.length,
		exercisesGraded: input.set.graded.size,
		nodes: [...worst.entries()]
			.filter(([id]) => input.names.has(id))
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.map(([nodeId, outcome]) => ({ nodeId, name: input.names.get(nodeId) ?? nodeId, outcome })),
		lowConfidenceGradings: low,
		applied: input.set.applied !== null,
		goalReached: input.set.applied?.reached === true,
	};
}

// ── study ───────────────────────────────────────────────────────────────────

export interface StudyFacts {
	kind: "study";
	startedAt: string;
	endedAt: string;
	durationSec: number;
	documentId: string | null;
	title: string | null;
	/** Pages read in the window (the reading rule of the assisted-study spec: a visit of at least the dwell time). */
	pagesRead: number;
	learnerMessages: number;
	nodesLinked: number;
	cardsCreated: number;
}

export function computeStudyFacts(input: {
	startedAt: string;
	endedAt: string;
	document: { documentId: string; title: string } | null;
	pagesRead: readonly number[];
	transcript: readonly TranscriptLine[];
	/** Node ids linked to a page of the document in the window. */
	linkedNodeIds: readonly string[];
	/** Cards created in the window, with their node ids. */
	createdCards: ReadonlyArray<{ nodeId: string; at: string }>;
}): StudyFacts {
	const linked = new Set(input.linkedNodeIds);
	return {
		kind: "study",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		durationSec: spanSec(input.startedAt, input.endedAt),
		documentId: input.document?.documentId ?? null,
		title: input.document?.title ?? null,
		pagesRead: new Set(input.pagesRead.filter((p) => Number.isInteger(p) && p > 0)).size,
		learnerMessages: input.transcript.filter((l) => l.role === "user" && l.text.trim() !== "" && inWindow(l.at, input)).length,
		nodesLinked: linked.size,
		cardsCreated: input.createdCards.filter((c) => linked.has(c.nodeId) && inWindow(c.at, input)).length,
	};
}

export type SessionFacts = ReviewFacts | LectureFacts | OfficeHoursFacts | ExerciseFacts | StudyFacts;

/** Does the session show any activity worth a debrief? An empty session produces no entry. */
export function hasSubstance(f: SessionFacts): boolean {
	switch (f.kind) {
		case "review": return f.reviews > 0;
		case "lecture": return f.slidesViewed + f.conceptsOpened + f.exercisesDone > 0;
		case "office_hours": return f.learnerMessages > 0 || f.verdicts.consistent + f.verdicts.differs + f.verdicts.not_verifiable > 0;
		case "exercises": return f.exercisesGraded > 0;
		case "study": return f.pagesRead + f.learnerMessages + f.nodesLinked > 0;
	}
}

export const FACT_KINDS: readonly SessionKind[] = ["review", "lecture", "office_hours", "exercises", "study"];
