// src/server/ext/lecture-cleanup.ts
/**
 * Leftovers of a chapter that did not finish (docs/ext/CONTRACTS.md "Stale chapter leftovers"). Before
 * staging, a chapter that failed, was stopped or was interrupted could leave its graph in the real store.
 * Its leftovers are found by provenance: the chapter's source id, for a chapter whose state is failed,
 * interrupted or stopped and that has no lecture. Removal goes through upstream's own removal seam
 * (core/graph-deletion.ts, the same one a source deletion uses), so a node or link that another source,
 * chapter, lecture or chat also refers to stays, with only the leftover's points removed.
 */

import { chapterSourceId } from "../../agent/ext/lecture/chapter-run.ts";
import { getGraph } from "../../core/graph.ts";
import { deleteSourcesTraces } from "../../core/graph-deletion.ts";
import type { Lecture } from "../../core/ext/lecture/lecture.ts";
import { isRunningPhase, isWorkingState, type BookRun, type ChapterState } from "../../core/ext/lecture/run-record.ts";
import type { GraphStore, SourceOrganizationStore } from "../../core/ports.ts";
import { HttpError } from "./http-error.ts";

/** The states whose graph leftovers the cleanup covers (a chapter with a lecture is never a leftover). */
export const LEFTOVER_STATES: ReadonlySet<string> = new Set(["failed", "interrupted", "stopped_cost", "stopped_provider"]);

export interface Leftover {
	bookId: string;
	bookTitle: string;
	chapterIndex: number;
	chapterTitle: string;
	state: ChapterState;
	/** Nodes that would be removed: every point of theirs is this chapter's. */
	nodes: number;
	/** Chain lines that would be removed. */
	chains: number;
	/** Nodes that stay because another source also refers to them. */
	kept: number;
}

export interface RemovalStats {
	nodesRemoved: number;
	chainsRemoved: number;
	nodesKept: number;
}

export interface LectureCleanupDeps {
	graphStore: GraphStore;
	organization: SourceOrganizationStore;
	books(): readonly BookRun[];
	lectures(): readonly Lecture[];
	extractionRunning(): boolean;
}

/** A read-only view for counting what a removal would do: reads are the real ones, every rewrite is dropped. */
function countingView(base: GraphStore): GraphStore {
	const view = {
		readNodes: () => base.readNodes(),
		readChains: () => base.readChains(),
		readCoverage: () => base.readCoverage(),
		readCheckpoints: () => base.readCheckpoints(),
		readPositions: () => base.readPositions(),
		rewriteLedgers: () => undefined,
		writePositions: () => undefined,
		deleteSources: () => 0,
	};
	// deleteSourcesTraces only reads these and writes through rewriteLedgers and writePositions; the rest of the port is never called.
	return view as unknown as GraphStore;
}

export function createLectureCleanup(deps: LectureCleanupDeps) {
	function countsFor(sourceId: string): { nodes: number; chains: number; kept: number } {
		const stats = deleteSourcesTraces(countingView(deps.graphStore), new Set([sourceId]), "delete-nodes");
		// The merged view: a node's provenance is spread over its create line and its link lines.
		const kept = new Set(
			getGraph(deps.graphStore)
				.nodes.filter((n) => n.provenance.some((p) => p.chatId === sourceId) && n.provenance.some((p) => p.chatId !== sourceId))
				.map((n) => n.id),
		);
		return { nodes: stats.nodesRemoved, chains: stats.chainsRemoved, kept: kept.size };
	}

	function hasLecture(bookId: string, chapterIndex: number): boolean {
		return deps.lectures().some((l) => l.bookId === bookId && l.chapter.index === chapterIndex);
	}

	/** Chapters of an earlier attempt that left something in the graph: failed, interrupted or stopped, no lecture. Read only. */
	function findStalePartialChapters(): Leftover[] {
		const out: Leftover[] = [];
		for (const book of deps.books()) {
			if (isRunningPhase(book.phase)) continue;
			for (const chapter of book.chapters) {
				if (!LEFTOVER_STATES.has(chapter.state) || hasLecture(book.bookId, chapter.chapter.index)) continue;
				const sourceId = chapterSourceId({ bookId: book.bookId, bookTitle: book.title }, chapter.chapter);
				const counts = countsFor(sourceId);
				const recorded = deps.graphStore.readSources().some((s) => s.id === sourceId);
				if (counts.nodes === 0 && counts.chains === 0 && !recorded) continue;
				out.push({
					bookId: book.bookId,
					bookTitle: book.title,
					chapterIndex: chapter.chapter.index,
					chapterTitle: chapter.chapter.title,
					state: chapter.state,
					...counts,
				});
			}
		}
		return out;
	}

	/** Removes one chapter's leftovers: its nodes and links (what only it refers to), its coverage, its source record and its place in the library. */
	function removeStalePartialChapter(bookId: string, chapterIndex: number): RemovalStats {
		const book = deps.books().find((b) => b.bookId === bookId);
		if (book === undefined) throw new HttpError(404, "unknown book");
		const chapter = book.chapters.find((c) => c.chapter.index === chapterIndex);
		if (chapter === undefined) throw new HttpError(400, "unknown chapter");
		if (isRunningPhase(book.phase)) throw new HttpError(409, "the book is still being made; retry when it finishes");
		if (isWorkingState(chapter.state)) throw new HttpError(409, "that chapter is still running");
		if (!LEFTOVER_STATES.has(chapter.state)) throw new HttpError(409, "that chapter has no leftovers to remove");
		if (hasLecture(bookId, chapterIndex)) throw new HttpError(409, "that chapter has lectures, so its leftovers are kept");
		if (deps.extractionRunning()) throw new HttpError(409, "an extraction is running; try again when it finishes");

		const sourceId = chapterSourceId({ bookId, bookTitle: book.title }, chapter.chapter);
		const before = countsFor(sourceId);
		const stats = deleteSourcesTraces(deps.graphStore, new Set([sourceId]), "delete-nodes");
		deps.graphStore.deleteSources(new Set([sourceId]));
		const state = deps.organization.read();
		if (sourceId in state.placements) {
			const placements = Object.fromEntries(Object.entries(state.placements).filter(([id]) => id !== sourceId));
			deps.organization.write({ ...state, placements });
		}
		return { nodesRemoved: stats.nodesRemoved, chainsRemoved: stats.chainsRemoved, nodesKept: before.kept };
	}

	return { findStalePartialChapters, removeStalePartialChapter };
}

export type LectureCleanup = ReturnType<typeof createLectureCleanup>;
