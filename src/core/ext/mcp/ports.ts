// src/core/ext/mcp/ports.ts
/**
 * What the read-only server needs from the outside (hexagonal rule of
 * src/core/ports.ts). `review` is typed as the app's ReviewDeps so the SAME
 * pure functions (computePlan, snapshot, goalReadiness...) run unchanged
 * (REQ-mcp-07); its stores have a write method only to satisfy that type, and
 * the composition root (src/server/ext/mcp/deps.ts) makes every one refuse.
 */

import type { ExplanationEvent } from "../explanations.ts";
import type { FrontierEvent } from "../frontier.ts";
import type { InboxEvent } from "../inbox.ts";
import type { JournalEvent } from "../debrief/journal.ts";
import type { Lecture } from "../lecture/lecture.ts";
import type { ExerciseEvent } from "../practice/exercises.ts";
import type { ReviewDeps } from "../review-service.ts";
import type { CycleLogEntry } from "../research-log.ts";
import type { VerificationEvent } from "../trust.ts";

export interface ReadLog<T> {
	/** Valid events in file order; never writes. */
	readAll(): T[];
}

export interface LectureReader {
	get(id: string): Lecture | null;
	list(): Lecture[];
}

export interface McpDeps {
	review: ReviewDeps;
	verification: ReadLog<VerificationEvent>;
	explanations: ReadLog<ExplanationEvent>;
	exercises: ReadLog<ExerciseEvent>;
	frontier: ReadLog<FrontierEvent>;
	inbox: ReadLog<InboxEvent>;
	researchLog: ReadLog<CycleLogEntry>;
	journal: ReadLog<JournalEvent>;
	lectures: LectureReader;
	/** ISO-8601 instant, called once per tool call. */
	now(): string;
	/** Throws a ToolError(data_newer_than_build) when any stamp is newer than this build. Never writes. */
	assertReadable(): void;
}

export interface RunOptions {
	/** Disable the study-state group and the learner-performance fields of get_node (REQ-mcp-06). */
	knowledgeOnly: boolean;
}
