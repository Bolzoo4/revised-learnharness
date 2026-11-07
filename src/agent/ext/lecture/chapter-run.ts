// src/agent/ext/lecture/chapter-run.ts
/**
 * One chapter run (REQ-lec-03, 04, 05, 07, 08, 18). In order:
 *   1. the chapter graph is extracted from the CHAPTER TEXT through upstream's
 *      notes path (never from generated discourse), into a STAGED graph: nothing
 *      it writes is visible to anyone until the chapter commits;
 *   2. an outline is written and split into lectures by estimated length;
 *   3. the lectures are written in sequence (each gets the previous summary),
 *      each validated and retried with feedback at most twice, and held in memory;
 *   4. only when every lecture is valid: the staged graph is committed, then the
 *      lectures are saved (a lecture never cites a node that is not active);
 *   5. coverage is reported: chapter nodes no lecture cites.
 * A chapter that fails, is stopped or aborted before step 4 discards its staged
 * graph: the real graph is unchanged and a retry starts from scratch.
 * Every dependency is injected, so the flow is tested without a model.
 */

import crypto from "node:crypto";
import type { GraphNode } from "../../../core/contracts.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import { buildLecture, type LectureDraft } from "../../../core/ext/lecture/build.ts";
import type { Chapter } from "../../../core/ext/lecture/chapters.ts";
import { parseLecture, type Lecture } from "../../../core/ext/lecture/lecture.ts";
import { generateWithFeedback } from "../../../core/ext/lecture/retry.ts";
import { splitOutline, type OutlineBlock } from "../../../core/ext/lecture/split.ts";
import { explainChapterError } from "../../../core/ext/lecture/explain-error.ts";
import type { ChapterState } from "../../../core/ext/lecture/run-record.ts";
import { feedbackFromErrors, uncoveredChapterNodes, validateLecture } from "../../../core/ext/lecture/validate.ts";
import type { LecturesStore } from "../../../core/ext/study-ports.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../../../core/ext/provider-limit.ts";
import { CostCeilingError, ProviderLimitedError, assertWithinCeiling } from "./structured.ts";
import type { LectureWriteInput } from "./writers.ts";

export const MAX_LECTURE_RETRIES = 2;

export type { ChapterState };

export interface ChapterProgress {
	chapter: Chapter;
	state: ChapterState;
	lectures: number;
	uncovered: number;
	error?: string;
}

export interface ChapterResult {
	state: "done" | "failed" | "stopped_cost" | "stopped_provider";
	lectureIds: string[];
	/** Chapter node ids no saved lecture cites (REQ-lec-07). */
	uncoveredNodeIds: string[];
	error?: string;
}

export interface BookRef {
	bookId: string;
	bookTitle: string;
}

export type GraphNodeView = Pick<GraphNode, "id" | "name" | "statement" | "provenance">;

/**
 * One chapter's staged graph (the composition root builds it over a staging store, see
 * src/server/ext/staged-graph-store.ts). Reads see the real graph plus this chapter's writes.
 */
export interface StagedChapterGraph {
	/** Imports the chapter text through the notes pipeline; billed by the pipeline itself. */
	importText(input: { filePath: string; text: string }): Promise<void>;
	/** Whether the import wrote its source record. */
	hasSource(filePath: string): boolean;
	/** The real nodes plus this chapter's staged nodes. */
	readNodes(): ReadonlyArray<GraphNodeView>;
	/** Replays the staged writes into the real graph, once. Throws if a write fails. */
	commit(): void;
	/** Drops the staged writes. Safe after commit. */
	discard(): void;
}

export interface ChapterRunDeps {
	gate: CostGate;
	lectures: Pick<LecturesStore, "save" | "list" | "remove">;
	/** A fresh staged graph for this chapter. */
	stageGraph(): StagedChapterGraph;
	/** The chapter's graph when it is already active in the real graph, or null. */
	activeGraph(filePath: string): { sourceId: string; nodes: ReadonlyArray<GraphNodeView> } | null;
	readChapterText(chapter: Chapter): Promise<string>;
	writeOutline(chapter: Chapter, chapterText: string): Promise<OutlineBlock[]>;
	writeLecture(input: LectureWriteInput): Promise<LectureDraft>;
	now(): string;
	onProgress?(p: ChapterProgress): void;
}

/** The label the chapter graph is imported under (also its provenance label in the graph). */
export function chapterSourcePath(book: BookRef, chapter: Chapter): string {
	return `${book.bookTitle}/${String(chapter.index).padStart(2, "0")} ${chapter.title}`;
}

/** The notes-source id of an imported file path (the same derivation as upstream's notes import). */
export function sourceIdForPath(filePath: string): string {
	return `src_${crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;
}

/** The notes-source id the chapter graph is extracted under. */
export function chapterSourceId(book: BookRef, chapter: Chapter): string {
	return sourceIdForPath(chapterSourcePath(book, chapter));
}

export async function runChapter(book: BookRef, chapter: Chapter, deps: ChapterRunDeps): Promise<ChapterResult> {
	let saved: Lecture[] = [];
	let uncovered: string[] = [];
	const report = (state: ChapterState, error?: string): void =>
		deps.onProgress?.({ chapter, state, lectures: saved.length, uncovered: uncovered.length, ...(error ? { error } : {}) });
	const result = (state: ChapterResult["state"], rawError?: string): ChapterResult => {
		const error = rawError === undefined ? undefined : explainChapterError(rawError);
		report(state, error);
		// Only a done chapter has saved lectures; a failed or stopped one saved none (its drafts were never stored).
		const done = state === "done";
		return { state, lectureIds: done ? saved.map((l) => l.id) : [], uncoveredNodeIds: done ? uncovered : [], ...(error ? { error } : {}) };
	};

	const filePath = chapterSourcePath(book, chapter);
	const sourceId = chapterSourceId(book, chapter);
	const stored = deps.lectures.list().filter((l) => l.bookId === book.bookId && l.chapter.index === chapter.index);

	// The first-run rule, re-evaluated for staging: a chapter whose graph is already active and whose
	// lectures are stored is done. Anything else is rebuilt from scratch.
	const active = deps.activeGraph(filePath);
	if (active !== null && stored.length > 0) {
		saved = stored;
		uncovered = uncoveredChapterNodes(stored, active.nodes.map((n) => n.id));
		return result("done");
	}

	const graph = deps.stageGraph();
	let committed = false;
	try {
		report("queued");
		assertWithinCeiling(deps.gate);
		const chapterText = await deps.readChapterText(chapter);

		// 1. the chapter graph, from the chapter text, into the staging overlay
		report("graph");
		assertWithinCeiling(deps.gate);
		await graph.importText({ filePath, text: chapterText });
		if (!graph.hasSource(filePath)) return result("failed", "the chapter graph import left no source record");
		const chapterNodeIds = graph
			.readNodes()
			.filter((n) => n.provenance.some((p) => p.chatId === sourceId))
			.map((n) => n.id);
		if (chapterNodeIds.length === 0) return result("failed", "the chapter graph is empty: no node was extracted from the chapter text");
		const existingNodeIds = new Set(graph.readNodes().map((n) => n.id));
		const chapterNodes = graph.readNodes().filter((n) => chapterNodeIds.includes(n.id));

		// 2. outline and split
		report("outline");
		const outline = await deps.writeOutline(chapter, chapterText);
		const groups = splitOutline(outline);
		if (groups.length === 0) return result("failed", "the outline produced no lecture");

		// 3. lectures in sequence, held in memory until the graph commits
		report("writing");
		let previousSummary: string | null = null;
		const drafts: Lecture[] = [];
		for (let i = 0; i < groups.length; i++) {
			const order = i + 1;
			const outcome = await generateWithFeedback<Lecture>({
				maxRetries: MAX_LECTURE_RETRIES,
				attempt: async (feedback) => {
					assertWithinCeiling(deps.gate);
					const draft = await deps.writeLecture({
						bookTitle: book.bookTitle,
						chapter,
						order,
						lectureCount: groups.length,
						blocks: groups[i]!,
						nodes: chapterNodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
						previousSummary,
						chapterText,
						feedback,
					});
					return buildLecture(draft, { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order, chapterSourceId: sourceId, createdAt: deps.now() });
				},
				validate: (lecture) =>
					parseLecture(JSON.parse(JSON.stringify(lecture))) === null
						? ["the lecture structure is malformed (check ids, roles, cues, and that exercise blocks carry seconds)"]
						: validateLecture(lecture, { existingNodeIds, chapterText }),
				feedback: feedbackFromErrors,
			});
			if (!outcome.ok) {
				return result("failed", `lecture ${order} stayed invalid after ${outcome.attempts} attempts: ${outcome.errors.join("; ")}`);
			}
			drafts.push(outcome.value);
			saved = drafts;
			previousSummary = outcome.value.summary;
			uncovered = uncoveredChapterNodes(drafts, chapterNodeIds);
			report("writing");
		}

		// 4. every lecture is valid: only now does the chapter's graph become active, then the lectures are saved
		graph.commit();
		committed = true;
		for (const lecture of drafts) deps.lectures.save(lecture);

		// Known limitation: a crash between the commit and the last save leaves active nodes without their
		// lectures. The next run of the chapter sees no stored lectures and rebuilds (the auditor links the
		// existing nodes), so nothing is lost; the stale nodes are listed by the cleanup until then.
		// Old lectures with ids never reached are removed here, only now that every new lecture is saved.
		const newIds = new Set(drafts.map((l) => l.id));
		for (const old of stored) if (!newIds.has(old.id)) deps.lectures.remove(old.id);

		return result("done");
	} catch (err) {
		// A provider usage limit is retryable: the chapter is stopped with the fixed text, never the provider's own.
		if (err instanceof ProviderLimitedError || deps.gate.reason?.() === "provider-limit") return result("stopped_provider", PROVIDER_LIMIT_MESSAGE);
		if (err instanceof CostCeilingError) return result("stopped_cost", err.message);
		return result("failed", err instanceof Error ? err.message : String(err));
	} finally {
		// Nothing staged reaches the real graph unless the commit above succeeded.
		if (!committed) graph.discard();
	}
}
