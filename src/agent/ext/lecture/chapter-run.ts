// src/agent/ext/lecture/chapter-run.ts
/**
 * One chapter run (REQ-lec-03, 04, 05, 07, 08, 18). In order:
 *   1. the chapter graph is extracted from the CHAPTER TEXT through upstream's
 *      notes path (never from generated discourse);
 *   2. an outline is written and split into lectures by estimated length;
 *   3. the lectures are written in sequence (each gets the previous summary),
 *      each validated and retried with feedback at most twice;
 *   4. coverage is reported: chapter nodes no lecture cites.
 * Every dependency is injected, so the flow is tested without a model.
 */

import type { GraphNode } from "../../../core/contracts.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import { buildLecture, type LectureDraft } from "../../../core/ext/lecture/build.ts";
import type { Chapter } from "../../../core/ext/lecture/chapters.ts";
import { parseLecture, type Lecture } from "../../../core/ext/lecture/lecture.ts";
import { generateWithFeedback } from "../../../core/ext/lecture/retry.ts";
import { splitOutline, type OutlineBlock } from "../../../core/ext/lecture/split.ts";
import { feedbackFromErrors, uncoveredChapterNodes, validateLecture } from "../../../core/ext/lecture/validate.ts";
import type { LecturesStore } from "../../../core/ext/study-ports.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../../../core/ext/provider-limit.ts";
import { CostCeilingError, ProviderLimitedError, assertWithinCeiling } from "./structured.ts";
import type { LectureWriteInput } from "./writers.ts";

export const MAX_LECTURE_RETRIES = 2;

export type ChapterState = "queued" | "graph" | "outline" | "writing" | "done" | "failed" | "stopped_cost" | "stopped_provider";

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

export interface ChapterRunDeps {
	gate: CostGate;
	lectures: Pick<LecturesStore, "save" | "list" | "remove">;
	/** Upstream's notes import (extraction.importNotes). Billed by the pipeline itself. */
	importChapterGraph(input: { filePath: string; text: string }): Promise<void>;
	/** The notes-source id of an imported file path, or null. */
	findSourceId(filePath: string): string | null;
	/** The merged graph's nodes (getGraph(...).nodes). */
	readNodes(): ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement" | "provenance">>;
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

export async function runChapter(book: BookRef, chapter: Chapter, deps: ChapterRunDeps): Promise<ChapterResult> {
	const saved: Lecture[] = [];
	let uncovered: string[] = [];
	const report = (state: ChapterState, error?: string): void =>
		deps.onProgress?.({ chapter, state, lectures: saved.length, uncovered: uncovered.length, ...(error ? { error } : {}) });
	const result = (state: ChapterResult["state"], error?: string): ChapterResult => {
		report(state, error);
		return { state, lectureIds: saved.map((l) => l.id), uncoveredNodeIds: uncovered, ...(error ? { error } : {}) };
	};

	try {
		report("queued");
		assertWithinCeiling(deps.gate);
		const chapterText = await deps.readChapterText(chapter);

		// 1. the chapter graph, from the chapter text
		report("graph");
		const filePath = chapterSourcePath(book, chapter);
		const nodesOf = (sourceId: string) => deps.readNodes().filter((n) => n.provenance.some((p) => p.chatId === sourceId));
		let sourceId = deps.findSourceId(filePath);
		if (sourceId === null || nodesOf(sourceId).length === 0) {
			assertWithinCeiling(deps.gate);
			await deps.importChapterGraph({ filePath, text: chapterText });
			sourceId = deps.findSourceId(filePath);
		}
		if (sourceId === null) return result("failed", "the chapter graph import left no source record");
		const chapterNodes = nodesOf(sourceId);
		if (chapterNodes.length === 0) return result("failed", "the chapter graph is empty: no node was extracted from the chapter text");
		const chapterNodeIds = chapterNodes.map((n) => n.id);
		const existingNodeIds = new Set(deps.readNodes().map((n) => n.id));

		// 2. outline and split
		report("outline");
		const outline = await deps.writeOutline(chapter, chapterText);
		const groups = splitOutline(outline);
		if (groups.length === 0) return result("failed", "the outline produced no lecture");

		// 3. lectures in sequence
		report("writing");
		let previousSummary: string | null = null;
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
					return buildLecture(draft, { bookId: book.bookId, bookTitle: book.bookTitle, chapter, order, chapterSourceId: sourceId!, createdAt: deps.now() });
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
			deps.lectures.save(outcome.value);
			saved.push(outcome.value);
			previousSummary = outcome.value.summary;
			uncovered = uncoveredChapterNodes(saved, chapterNodeIds);
			report("writing");
		}

		// Known limitation: new lectures overwrite old ones with the same id as they are saved, so a failed
		// re-run can leave a mix of new and old lectures. Old lectures with ids never reached are kept.
		// Only now, with every new lecture saved, drop the chapter's earlier lectures that were not overwritten.
		const newIds = new Set(saved.map((l) => l.id));
		for (const old of deps.lectures.list()) {
			if (old.bookId === book.bookId && old.chapter.index === chapter.index && !newIds.has(old.id)) deps.lectures.remove(old.id);
		}

		return result("done");
	} catch (err) {
		// A provider usage limit is retryable: the chapter is stopped with the fixed text, never the provider's own.
		if (err instanceof ProviderLimitedError || deps.gate.reason?.() === "provider-limit") return result("stopped_provider", PROVIDER_LIMIT_MESSAGE);
		if (err instanceof CostCeilingError) return result("stopped_cost", err.message);
		return result("failed", err instanceof Error ? err.message : String(err));
	}
}
