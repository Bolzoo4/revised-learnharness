// src/core/ext/mcp/ports.ts
/**
 * What the read-only server needs from the outside (hexagonal rule of
 * src/core/ports.ts). `review` is typed as the app's ReviewDeps so the SAME
 * pure functions (computePlan, snapshot, goalReadiness...) run unchanged
 * (REQ-mcp-07); its stores have a write method only to satisfy that type, and
 * the composition root (src/server/ext/mcp/deps.ts) makes every one refuse.
 */

import type { DocumentEvent } from "../study/documents.ts";
import type { ExplanationEvent } from "../explanations.ts";
import type { FrontierEvent } from "../frontier.ts";
import type { InboxEvent } from "../inbox.ts";
import type { JournalEvent } from "../debrief/journal.ts";
import type { CitingLecture } from "../lecture/lecture-graph.ts";
import type { Lecture } from "../lecture/lecture.ts";
import type { ExerciseEvent } from "../practice/exercises.ts";
import type { ReadingEvent } from "../study/reading.ts";
import type { ReviewDeps } from "../review-service.ts";
import type { CycleLogEntry } from "../research-log.ts";
import type { VerificationEvent } from "../trust.ts";
import type { VectorIndex } from "../vector-index.ts";

export interface ReadLog<T> {
	/** Valid events in file order; never writes. */
	readAll(): T[];
}

export interface LectureReader {
	get(id: string): Lecture | null;
	list(): Lecture[];
	/**
	 * The lectures citing a node, sorted by id. Null when the lecture index could
	 * not be completed within this call's read budget: a later call resumes it.
	 */
	citing(nodeId: string): CitingLecture[] | null;
}

/**
 * The app's own endpoints, reached over loopback (the write tools and get_sandbox only).
 * A non-2xx answer is a ToolError carrying the app's text; an unreachable app is
 * a ToolError too. Neither ever crashes the server.
 */
export interface AppApiPort {
	post(path: string, body: unknown): Promise<unknown>;
	put(path: string, body: unknown): Promise<unknown>;
	get(path: string): Promise<unknown>;
}

/** The label of each imported source file (its file name, never a path): read-only, from graph/sources.json. */
export interface SourceLabels {
	labels(): ReadonlyMap<string, string>;
}

/** The semantic index as the read-only server sees it (REQ-search-08, 09). Loading never writes. */
export type SemanticState =
	| { ok: true; index: VectorIndex; embedQuery(text: string): Promise<Float32Array> }
	| { ok: false; reason: string };

export interface SemanticPort {
	load(): Promise<SemanticState>;
	/**
	 * Optional and synchronous: the reason the index cannot be used, when the file alone decides it (missing,
	 * unreadable, another model). Null when unknown without loading. A tool uses it to answer synchronously.
	 */
	unavailable?(): string | null;
}

export interface McpDeps {
	review: ReviewDeps;
	sources: SourceLabels;
	/** The write tools' only way to change anything: the running app's API. */
	appApi: AppApiPort;
	verification: ReadLog<VerificationEvent>;
	explanations: ReadLog<ExplanationEvent>;
	exercises: ReadLog<ExerciseEvent>;
	frontier: ReadLog<FrontierEvent>;
	inbox: ReadLog<InboxEvent>;
	researchLog: ReadLog<CycleLogEntry>;
	journal: ReadLog<JournalEvent>;
	documents: ReadLog<DocumentEvent>;
	reading: ReadLog<ReadingEvent>;
	lectures: LectureReader;
	/** The semantic index. Absent when the build has none: the search tools then answer from keyword matches with a note. */
	semantic?: SemanticPort;
	/** ISO-8601 instant, called once per tool call. */
	now(): string;
	/** Throws a ToolError(data_newer_than_build) when any stamp is newer than this build. Never writes. */
	assertReadable(): void;
}

export interface RunOptions {
	/** Disable the study-state group, the write group and the stage fields (REQ-mcp-06). */
	knowledgeOnly: boolean;
}
