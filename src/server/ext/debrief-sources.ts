// src/server/ext/debrief-sources.ts
/**
 * @node ext/debrief/sources
 * Reads the ledgers and the chat store and hands the pure facts functions
 * their inputs (REQ-deb-03). READ-ONLY by construction: every dependency is
 * a reader, there is nothing here to write with (REQ-deb-07). One factory
 * over injected readers so tests drive it with memory data.
 */

import type { GraphChain } from "../../core/contracts.ts";
import { type ActivityEvent, deriveLectureSessions, explicitEnds } from "../../core/ext/debrief/activity.ts";
import {
	computeExerciseFacts,
	computeLectureFacts,
	computeOfficeHoursFacts,
	computeReviewFacts,
	computeStudyFacts,
	type SessionFacts,
	type TranscriptLine,
} from "../../core/ext/debrief/facts.ts";
import type { JournalEvent } from "../../core/ext/debrief/journal.ts";
import type { DebriefSources } from "../../core/ext/debrief/ports.ts";
import { endedAtOf, ownerOfEvent, type SessionRef, type Window } from "../../core/ext/debrief/sessions.ts";
import { computeWeeklyFacts, type WeeklyWindow } from "../../core/ext/debrief/weekly.ts";
import type { CardEvent } from "../../core/ext/cards.ts";
import { claimNodes } from "../../core/ext/deck.ts";
import { DEFAULT_RETENTION } from "../../core/ext/fsrs.ts";
import { deriveGoals, type Goal } from "../../core/ext/goals.ts";
import { deriveExerciseSets, type ExerciseEvent } from "../../core/ext/practice/exercises.ts";
import type { OfficeHoursEvent } from "../../core/ext/practice/office-hours.ts";
import type { GoalEvent } from "../../core/ext/goals.ts";
import type { ReviewEvent } from "../../core/ext/review.ts";
import { deriveMarks } from "../../core/ext/review-state.ts";
import type { TrustLevel } from "../../core/ext/trust.ts";

/** What the sources need to know about assisted study. Optional: without it study sessions still get message counts. */
export interface StudyFeed {
	documentOfChat(chatId: string): { documentId: string; title: string } | null;
	/** Pages read by the reading rule, counting only visits inside the window. */
	pagesRead(documentId: string, startedAt: string, endedAt: string): number[];
	/** Node ids linked to a page of the document inside the window. */
	linkedNodeIds(documentId: string, startedAt: string, endedAt: string): string[];
	/** The newest reading or link event of the document, or null. */
	lastActivityAt(documentId: string): string | null;
}

export interface ChatRow {
	id: string;
	title: string;
	kind: string;
	createdAt: string;
	updatedAt: string;
}

export interface SourcesDeps {
	chats: { list(): ChatRow[]; messages(chatId: string): unknown[] };
	reviewEvents(): ReviewEvent[];
	officeHoursEvents(): OfficeHoursEvent[];
	exerciseEvents(): ExerciseEvent[];
	cardEvents(): CardEvent[];
	goalEvents(): GoalEvent[];
	activityEvents(): ActivityEvent[];
	journal(): JournalEvent[];
	graph(): { nodes: ReadonlyArray<{ id: string; name: string }>; chains: readonly GraphChain[] };
	lecture(id: string): { title: string; slides: ReadonlyArray<{ id: string }>; blocks: ReadonlyArray<{ id: string; role: string }> } | null;
	/** Trust levels of the given nodes; a node missing from the map is `unverified`. */
	trustLevels(nodeIds: readonly string[]): ReadonlyMap<string, TrustLevel>;
	study?: StudyFeed;
	now(): Date;
	idleMs: number;
	budgetSec: number;
}

const CHAT_KINDS = new Set(["review", "office_hours", "study"]);

/** Flattens stored chat messages to plain text lines; anything that is not a user or assistant message with text is skipped. */
export function transcriptOf(messages: readonly unknown[]): TranscriptLine[] {
	const out: TranscriptLine[] = [];
	for (const m of messages) {
		if (typeof m !== "object" || m === null) continue;
		const { role, content, timestamp } = m as { role?: unknown; content?: unknown; timestamp?: unknown };
		if ((role !== "user" && role !== "assistant") || typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
				.map((b) => b.text)
				.join("\n");
		}
		out.push({ role, at: timestamp, text });
	}
	return out;
}

const later = (a: string, b: string | null): string => (b !== null && Date.parse(b) > Date.parse(a) ? b : a);

export function createDebriefSources(deps: SourcesDeps): DebriefSources {
	function refs(): SessionRef[] {
		const out: SessionRef[] = [];
		for (const c of deps.chats.list()) {
			if (!CHAT_KINDS.has(c.kind)) continue;
			let last = c.updatedAt;
			if (c.kind === "study" && deps.study) {
				const doc = deps.study.documentOfChat(c.id);
				if (doc) last = later(last, deps.study.lastActivityAt(doc.documentId));
			}
			out.push({ sessionId: c.id, kind: c.kind as SessionRef["kind"], title: c.title, startedAt: c.createdAt, lastActivityAt: last });
		}
		const goals = deriveGoals(deps.goalEvents());
		for (const set of deriveExerciseSets(deps.exerciseEvents())) {
			let last = set.createdAt;
			for (const g of set.graded.values()) last = later(last, g.at);
			out.push({ sessionId: set.setId, kind: "exercises", title: `Exercises: ${goals.find((g) => g.id === set.goalId)?.title ?? set.goalId}`, startedAt: set.createdAt, lastActivityAt: last });
		}
		for (const s of deriveLectureSessions(deps.activityEvents())) {
			out.push({ sessionId: s.sessionId, kind: "lecture", title: deps.lecture(s.lectureId)?.title ?? s.lectureId, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt });
		}
		return out;
	}

	function reviewWindows(target: SessionRef, targetEnd: string): Window[] {
		const ends = explicitEnds(deps.activityEvents());
		const windows: Window[] = [{ sessionId: target.sessionId, startedAt: target.startedAt, endedAt: targetEnd }];
		for (const r of refs()) {
			if (r.kind !== "review" || r.sessionId === target.sessionId) continue;
			windows.push({ sessionId: r.sessionId, startedAt: r.startedAt, endedAt: endedAtOf(r, deps.now(), deps.idleMs, ends.get(r.sessionId)) ?? r.lastActivityAt });
		}
		return windows;
	}

	function sessionFacts(ref: SessionRef, endedAt: string): SessionFacts {
		const g = deps.graph();
		const names = new Map(g.nodes.map((n) => [n.id, n.name] as const));
		const base = { startedAt: ref.startedAt, endedAt };
		switch (ref.kind) {
			case "review": {
				const windows = reviewWindows(ref, endedAt);
				return computeReviewFacts({ ...base, events: deps.reviewEvents(), owns: (at) => ownerOfEvent(at, windows) === ref.sessionId, names, budgetSec: deps.budgetSec });
			}
			case "lecture": {
				const s = deriveLectureSessions(deps.activityEvents()).find((x) => x.sessionId === ref.sessionId);
				const lecture = s ? deps.lecture(s.lectureId) : null;
				return computeLectureFacts({
					...base,
					lectureId: s?.lectureId ?? "",
					lecture: lecture ? { title: lecture.title, slideIds: lecture.slides.map((x) => x.id), exerciseBlockIds: lecture.blocks.filter((b) => b.role === "exercise").map((b) => b.id) } : null,
					slides: s?.slides ?? new Set(),
					concepts: s?.concepts ?? new Set(),
					exercises: s?.exercises ?? new Set(),
				});
			}
			case "office_hours":
				return computeOfficeHoursFacts({ ...base, chatId: ref.sessionId, events: deps.officeHoursEvents(), transcript: transcriptOf(deps.chats.messages(ref.sessionId)) });
			case "exercises": {
				const set = deriveExerciseSets(deps.exerciseEvents()).find((x) => x.setId === ref.sessionId);
				if (!set) throw new Error(`exercise set ${ref.sessionId} no longer exists`);
				return computeExerciseFacts({ ...base, set, names });
			}
			case "study": {
				const doc = deps.study?.documentOfChat(ref.sessionId) ?? null;
				const linked = doc && deps.study ? deps.study.linkedNodeIds(doc.documentId, ref.startedAt, endedAt) : [];
				return computeStudyFacts({
					...base,
					document: doc,
					pagesRead: doc && deps.study ? deps.study.pagesRead(doc.documentId, ref.startedAt, endedAt) : [],
					transcript: transcriptOf(deps.chats.messages(ref.sessionId)),
					linkedNodeIds: linked,
					createdCards: deps.cardEvents().flatMap((e) => (e.type === "created" ? [{ nodeId: e.nodeId, at: e.at }] : [])),
				});
			}
		}
	}

	function weeklyFacts(window: WeeklyWindow) {
		const g = deps.graph();
		const goals: Goal[] = deriveGoals(deps.goalEvents());
		const reviewEvents = deps.reviewEvents();
		const info = claimNodes(goals, g.chains, deriveMarks(reviewEvents));
		const levels = deps.trustLevels(g.nodes.map((n) => n.id));
		return computeWeeklyFacts({
			window,
			reviewEvents,
			goals,
			chains: g.chains,
			nodeIds: new Set(g.nodes.map((n) => n.id)),
			retentionOf: (id) => info.get(id)?.retention ?? DEFAULT_RETENTION,
			trustOf: (id) => levels.get(id) ?? "unverified",
			journal: deps.journal(),
			budgetSec: deps.budgetSec,
		});
	}

	return { sessions: refs, sessionFacts, weeklyFacts };
}
