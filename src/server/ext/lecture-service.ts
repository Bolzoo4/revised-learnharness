// src/server/ext/lecture-service.ts
/**
 * The lecture stage's service (REQ-lec-01 to 08): starts a book ingest in the
 * background, tracks per-chapter status, and answers the read queries of the
 * pages and routes. Everything impure is injected; the live wiring is
 * lecture-live.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { mapPool, MAX_PARALLEL_CHAPTERS, runBook } from "../../agent/ext/lecture/book-run.ts";
import { runChapter, type ChapterProgress, type ChapterResult, type ChapterRunDeps } from "../../agent/ext/lecture/chapter-run.ts";
import type { LectureWriteInput } from "../../agent/ext/lecture/writers.ts";
import type { GraphNode } from "../../core/contracts.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import type { LectureDraft } from "../../core/ext/lecture/build.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { Chapter, ChapterStart } from "../../core/ext/lecture/chapters.ts";
import { citingLectures, lectureOverlay } from "../../core/ext/lecture/lecture-graph.ts";
import type { OutlineBlock } from "../../core/ext/lecture/split.ts";
import {
	boundRunRecords,
	formatChapterOutcome,
	interruptBook,
	isRetryableState,
	isRunningPhase,
	isWorkingState,
	secondsBetween,
	type BookRun,
	type ChapterRun,
	type ChapterStage,
	type LectureRunStore,
} from "../../core/ext/lecture/run-record.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../../core/ext/provider-limit.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";
import { HttpError } from "./http-error.ts";

/** A book's run, in memory and in the run store (the same shape: core/ext/lecture/run-record.ts). */
export type BookRunStatus = BookRun;

export class LectureServiceError extends HttpError {}

export interface LectureServiceDeps {
	lectures: LecturesStore;
	library?: SourceLibrary;
	gate: CostGate;
	graphNodes(): ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement" | "provenance">>;
	importChapterGraph: ChapterRunDeps["importChapterGraph"];
	findSourceId: ChapterRunDeps["findSourceId"];
	pdf: {
		exists(pdfPath: string): boolean;
		readBookmarks(pdfPath: string): Promise<{ pageCount: number; bookmarks: ChapterStart[] }>;
		readPageTexts(pdfPath: string): Promise<string[]>;
		readChapterText(pdfPath: string, chapter: Chapter): Promise<string>;
	};
	writers: {
		detectChaptersWithLlm(excerpt: string, pageCount: number): Promise<ChapterStart[]>;
		writeOutline(chapter: Chapter, chapterText: string): Promise<OutlineBlock[]>;
		writeLecture(input: LectureWriteInput): Promise<LectureDraft>;
	};
	/** Shared run registry (a globalThis map in the live wiring, so dev reloads do not lose it). */
	runs: Map<string, BookRunStatus>;
	/** Persisted run state (data/ext/lecture-runs.json). Absent = nothing is kept across restarts. */
	runStore?: LectureRunStore;
	/** One line per chapter outcome. Default: console.log (the desktop app captures it into its log). */
	log?(line: string): void;
	now?: () => string;
}

/** "b" + 8 hex of the path hash: stable per PDF, filesystem-safe (lecture ids embed it). */
export function bookIdFor(pdfPath: string): string {
	return `b${createHash("sha256").update(pdfPath).digest("hex").slice(0, 8)}`;
}

const sameChapter = (a: Chapter, b: Chapter): boolean => a.index === b.index && a.pageStart === b.pageStart && a.pageEnd === b.pageEnd;

function errorName(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string") return code;
	return err instanceof Error ? err.name : "error";
}

export function createLectureService(deps: LectureServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const log = deps.log ?? ((line: string) => console.log(line));

	/** Writes the bounded run state and keeps the in-memory registry to the same books. Never throws. */
	function persist(): void {
		const kept = boundRunRecords([...deps.runs.values()]);
		const keptIds = new Set(kept.map((b) => b.bookId));
		for (const id of [...deps.runs.keys()]) if (!keptIds.has(id)) deps.runs.delete(id);
		if (deps.runStore === undefined) return;
		try {
			deps.runStore.save(kept);
		} catch (err) {
			// The message can carry a path: log the kind only.
			console.error("[lectures] could not save the run state:", errorName(err));
		}
	}

	/** On start: books left in flight by a closed app become interrupted (logged once, then saved). */
	function restore(): void {
		if (deps.runStore === undefined) return;
		let loaded: BookRun[];
		try {
			loaded = deps.runStore.load();
		} catch {
			return;
		}
		const at = now();
		let changed = false;
		for (const book of loaded) {
			if (deps.runs.has(book.bookId)) continue;
			const { book: converted, interrupted } = interruptBook(book, at);
			deps.runs.set(converted.bookId, converted);
			for (const c of interrupted) {
				const before = book.chapters.find((x) => x.chapter.index === c.chapter.index);
				log(
					formatChapterOutcome({
						bookId: book.bookId,
						chapter: c.chapter,
						state: c.state,
						...(c.error ? { error: c.error } : {}),
						...(c.stage ? { stage: c.stage } : {}),
						seconds: secondsBetween(before?.startedAt, before?.updatedAt ?? at),
					}),
				);
			}
			if (converted.phase !== book.phase || interrupted.length > 0) changed = true;
		}
		if (changed) persist();
	}

	function chapterOf(status: BookRunStatus, index: number): ChapterRun | undefined {
		return status.chapters.find((c) => c.chapter.index === index);
	}

	/** A chapter's progress: keeps the stage and the checkpoint, stamps the times, logs the final states. */
	function onProgress(status: BookRunStatus, p: ChapterProgress): void {
		const i = status.chapters.findIndex((c) => c.chapter.index === p.chapter.index);
		if (i < 0) return;
		const prev = status.chapters[i]!;
		const at = now();
		const stage: ChapterStage | undefined =
			p.state === "graph" || p.state === "outline" || p.state === "writing" ? p.state : p.state === "queued" ? undefined : prev.stage;
		const next: ChapterRun = {
			chapter: p.chapter,
			state: p.state,
			lectures: p.lectures,
			uncovered: p.uncovered,
			...(stage !== undefined ? { stage } : {}),
			...(prev.importedParts !== undefined ? { importedParts: prev.importedParts } : {}),
			...(p.error !== undefined ? { error: p.error } : {}),
			startedAt: p.state === "queued" ? at : (prev.startedAt ?? at),
			updatedAt: at,
		};
		status.chapters[i] = next;
		if (!isWorkingState(p.state)) {
			log(
				formatChapterOutcome({
					bookId: status.bookId,
					chapter: p.chapter,
					state: p.state,
					...(p.error ? { error: p.error } : {}),
					...(stage ? { stage } : {}),
					seconds: secondsBetween(next.startedAt, at),
				}),
			);
		}
		persist();
	}

	/** One chapter through the chapter pipeline, its progress and graph checkpoints written to the status. */
	function runOne(status: BookRunStatus, chapter: Chapter, importedParts: number | undefined): Promise<ChapterResult> {
		return runChapter({ bookId: status.bookId, bookTitle: status.title }, chapter, {
			gate: deps.gate,
			lectures: deps.lectures,
			importChapterGraph: deps.importChapterGraph,
			findSourceId: deps.findSourceId,
			readNodes: deps.graphNodes,
			readChapterText: (c) => deps.pdf.readChapterText(status.pdfPath, c),
			writeOutline: deps.writers.writeOutline,
			writeLecture: deps.writers.writeLecture,
			now,
			...(importedParts !== undefined ? { importedParts } : {}),
			onImported: (parts) => {
				const cur = chapterOf(status, chapter.index);
				if (cur !== undefined) cur.importedParts = parts;
				persist();
			},
			onProgress: (p) => onProgress(status, p),
		});
	}

	/** The book's final phase once every chapter has a final state. */
	function settle(status: BookRunStatus): void {
		status.phase = status.chapters.every((c) => c.state === "done") ? "done" : "failed";
		delete status.error;
		// A provider limit is retryable: the book ends with the fixed text, not the generic failure.
		if (status.chapters.some((c) => c.state === "stopped_provider")) status.error = PROVIDER_LIMIT_MESSAGE;
		else if (status.phase === "failed") status.error = "some chapters did not finish; see the per-chapter errors";
		status.updatedAt = now();
		persist();
	}

	function fail(status: BookRunStatus, err: unknown): void {
		status.phase = "failed";
		// The raw message can carry paths or provider detail: the status is served to the client, so log the real one.
		console.error("[ext] book ingest failed:", err);
		status.error = "the book run failed; see the server log";
		status.updatedAt = now();
		persist();
	}

	restore();

	function startBookIngest(input: { pdfPath: string; title?: string }): { bookId: string; finished: Promise<void> } {
		const pdfPath = input.pdfPath;
		if (!path.isAbsolute(pdfPath) || !pdfPath.toLowerCase().endsWith(".pdf")) throw new LectureServiceError(400, "pdfPath must be an absolute path to a .pdf file");
		if (!deps.pdf.exists(pdfPath)) throw new LectureServiceError(404, "that PDF does not exist");
		const bookId = bookIdFor(pdfPath);
		const previous = deps.runs.get(bookId);
		if (previous !== undefined && isRunningPhase(previous.phase)) {
			return { bookId, finished: Promise.resolve() };
		}
		if (!deps.gate.allowed()) {
			throw new LectureServiceError(429, deps.gate.reason?.() === "provider-limit" ? PROVIDER_LIMIT_MESSAGE : "the daily ceiling for background model work is spent");
		}
		const title = (input.title?.trim() || path.basename(pdfPath, path.extname(pdfPath))).trim();
		const status: BookRunStatus = { bookId, title, pdfPath, phase: "detecting", chapters: [], startedAt: now() };
		deps.runs.set(bookId, status);
		const book = { bookId, bookTitle: title };
		const finished = runBook(book, {
			readBookmarks: () => deps.pdf.readBookmarks(pdfPath),
			readPageTexts: () => deps.pdf.readPageTexts(pdfPath),
			detectChaptersWithLlm: deps.writers.detectChaptersWithLlm,
			...(deps.library ? { registerSource: () => registerBookAsPrimary(deps.library!, pdfPath, title) } : {}),
			onChapters: (chapters) => {
				status.phase = "running";
				// A chapter of an earlier run of this book keeps its graph checkpoint when its pages are unchanged.
				status.chapters = chapters.map((chapter) => {
					const old = previous?.chapters.find((c) => sameChapter(c.chapter, chapter));
					return { chapter, state: "queued", lectures: 0, uncovered: 0, ...(old?.importedParts !== undefined ? { importedParts: old.importedParts } : {}) };
				});
				persist();
			},
			runChapter: (chapter) => runOne(status, chapter, chapterOf(status, chapter.index)?.importedParts),
		}).then(() => settle(status), (err: unknown) => fail(status, err));
		return { bookId, finished };
	}

	/**
	 * Re-runs the chapters that need it: one chapter (chapterIndex) or every failed, interrupted,
	 * stopped_cost or stopped_provider one. Starts in the background; throws for the refusals.
	 */
	function retryChapters(bookId: string, chapterIndex?: number): { chapters: number[]; finished: Promise<void> } {
		const status = deps.runs.get(bookId);
		if (status === undefined) throw new LectureServiceError(404, "unknown book");
		if (isRunningPhase(status.phase)) throw new LectureServiceError(409, "the book is still being made; retry when it finishes");
		let targets: ChapterRun[];
		if (chapterIndex === undefined) {
			targets = status.chapters.filter((c) => isRetryableState(c.state));
		} else {
			const c = chapterOf(status, chapterIndex);
			if (c === undefined) throw new LectureServiceError(400, "unknown chapter");
			if (isWorkingState(c.state)) throw new LectureServiceError(409, "that chapter is already running");
			if (!isRetryableState(c.state)) throw new LectureServiceError(409, "that chapter does not need a retry");
			targets = [c];
		}
		if (targets.length === 0) throw new LectureServiceError(409, "no chapter needs a retry");
		if (!deps.pdf.exists(status.pdfPath)) throw new LectureServiceError(409, "the book PDF is no longer stored");
		if (!deps.gate.allowed()) {
			throw new LectureServiceError(429, deps.gate.reason?.() === "provider-limit" ? PROVIDER_LIMIT_MESSAGE : "the daily ceiling for background model work is spent");
		}
		const indices = targets.map((c) => c.chapter.index);
		const at = now();
		for (const c of targets) {
			const i = status.chapters.findIndex((x) => x.chapter.index === c.chapter.index);
			status.chapters[i] = {
				chapter: c.chapter,
				state: "queued",
				lectures: 0,
				uncovered: 0,
				...(c.importedParts !== undefined ? { importedParts: c.importedParts } : {}),
				startedAt: at,
				updatedAt: at,
			};
		}
		status.phase = "running";
		delete status.error;
		status.updatedAt = at;
		persist();
		const finished = mapPool(indices, MAX_PARALLEL_CHAPTERS, (index) => {
			const c = chapterOf(status, index)!;
			return runOne(status, c.chapter, c.importedParts ?? 0);
		}).then(() => settle(status), (err: unknown) => fail(status, err));
		return { chapters: indices, finished };
	}

	return {
		startBookIngest,
		retryChapters,
		runStatuses: (): BookRunStatus[] => [...deps.runs.values()],
		listLectures: () => deps.lectures.list(),
		getLecture: (id: string) => deps.lectures.get(id),
		overlay: () => lectureOverlay(deps.lectures.list(), new Set(deps.graphNodes().map((n) => n.id))),
		citing: (nodeId: string) => citingLectures(nodeId, deps.lectures.list()),
	};
}

export type LectureService = ReturnType<typeof createLectureService>;
