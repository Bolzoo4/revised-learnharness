// src/server/ext/lecture-service.ts
/**
 * The lecture stage's service (REQ-lec-01 to 08): starts a book ingest in the
 * background, tracks per-chapter status, and answers the read queries of the
 * pages and routes. Everything impure is injected; the live wiring is
 * lecture-live.ts.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { runBook } from "../../agent/ext/lecture/book-run.ts";
import { runChapter, type ChapterProgress, type ChapterRunDeps } from "../../agent/ext/lecture/chapter-run.ts";
import type { LectureWriteInput } from "../../agent/ext/lecture/writers.ts";
import type { GraphNode } from "../../core/contracts.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import type { LectureDraft } from "../../core/ext/lecture/build.ts";
import { registerBookAsPrimary } from "../../core/ext/lecture/book-source.ts";
import type { Chapter, ChapterStart } from "../../core/ext/lecture/chapters.ts";
import { citingLectures, lectureOverlay } from "../../core/ext/lecture/lecture-graph.ts";
import type { OutlineBlock } from "../../core/ext/lecture/split.ts";
import type { SourceLibrary } from "../../core/ext/sources.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";

export interface BookRunStatus {
	bookId: string;
	title: string;
	pdfPath: string;
	phase: "detecting" | "running" | "done" | "failed";
	chapters: ChapterProgress[];
	error?: string;
	startedAt: string;
}

export class LectureServiceError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

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
	now?: () => string;
}

/** "b" + 8 hex of the path hash: stable per PDF, filesystem-safe (lecture ids embed it). */
export function bookIdFor(pdfPath: string): string {
	return `b${createHash("sha256").update(pdfPath).digest("hex").slice(0, 8)}`;
}

export function createLectureService(deps: LectureServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());

	function startBookIngest(input: { pdfPath: string; title?: string }): { bookId: string; finished: Promise<void> } {
		const pdfPath = input.pdfPath;
		if (!path.isAbsolute(pdfPath) || !pdfPath.toLowerCase().endsWith(".pdf")) throw new LectureServiceError(400, "pdfPath must be an absolute path to a .pdf file");
		if (!deps.pdf.exists(pdfPath)) throw new LectureServiceError(404, "that PDF does not exist");
		const bookId = bookIdFor(pdfPath);
		const running = deps.runs.get(bookId);
		if (running !== undefined && (running.phase === "detecting" || running.phase === "running")) {
			return { bookId, finished: Promise.resolve() };
		}
		if (!deps.gate.allowed()) throw new LectureServiceError(429, "the daily ceiling for background model work is spent");
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
				status.chapters = chapters.map((chapter) => ({ chapter, state: "queued", lectures: 0, uncovered: 0 }));
			},
			runChapter: (chapter) =>
				runChapter(book, chapter, {
					gate: deps.gate,
					lectures: deps.lectures,
					importChapterGraph: deps.importChapterGraph,
					findSourceId: deps.findSourceId,
					readNodes: deps.graphNodes,
					readChapterText: (c) => deps.pdf.readChapterText(pdfPath, c),
					writeOutline: deps.writers.writeOutline,
					writeLecture: deps.writers.writeLecture,
					now,
					onProgress: (p) => {
						const i = status.chapters.findIndex((c) => c.chapter.index === p.chapter.index);
						if (i >= 0) status.chapters[i] = p;
					},
				}),
		}).then(
			() => {
				status.phase = status.chapters.every((c) => c.state === "done") ? "done" : "failed";
				if (status.phase === "failed") status.error = "some chapters did not finish; see the per-chapter errors";
			},
			(err: unknown) => {
				status.phase = "failed";
				status.error = err instanceof Error ? err.message : String(err);
			},
		);
		return { bookId, finished };
	}

	return {
		startBookIngest,
		runStatuses: (): BookRunStatus[] => [...deps.runs.values()],
		listLectures: () => deps.lectures.list(),
		getLecture: (id: string) => deps.lectures.get(id),
		overlay: () => lectureOverlay(deps.lectures.list(), new Set(deps.graphNodes().map((n) => n.id))),
		citing: (nodeId: string) => citingLectures(nodeId, deps.lectures.list()),
	};
}

export type LectureService = ReturnType<typeof createLectureService>;
