// src/agent/ext/lecture/book-run.ts
/**
 * A whole book (REQ-lec-01, 02, 05): chapters from the bookmarks (LLM fallback
 * when absent), the book registered as an active primary source, chapters run
 * in parallel up to a limit.
 */

import { chaptersFromStarts, validateChapterStarts, buildChapterDetectExcerpt, type Chapter, type ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import type { BookRef, ChapterResult } from "./chapter-run.ts";

export const MAX_PARALLEL_CHAPTERS = 3;

export interface BookRunDeps {
	readBookmarks(): Promise<{ pageCount: number; bookmarks: ChapterStart[] }>;
	readPageTexts(): Promise<string[]>;
	detectChaptersWithLlm(excerpt: string, pageCount: number): Promise<ChapterStart[]>;
	/** Registers the book as an active primary source (REQ-lec-02). Absent = the library is not installed. */
	registerSource?(): void;
	runChapter(chapter: Chapter): Promise<ChapterResult>;
	onChapters?(chapters: Chapter[]): void;
	concurrency?: number;
}

export interface BookResult {
	book: BookRef;
	chapters: Array<{ chapter: Chapter; result: ChapterResult }>;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
}

export async function detectChapters(deps: Pick<BookRunDeps, "readBookmarks" | "readPageTexts" | "detectChaptersWithLlm">): Promise<Chapter[]> {
	const { pageCount, bookmarks } = await deps.readBookmarks();
	if (bookmarks.length > 0 && validateChapterStarts(bookmarks, pageCount).length === 0) return chaptersFromStarts(bookmarks, pageCount);
	const excerpt = buildChapterDetectExcerpt(await deps.readPageTexts());
	const proposed = await deps.detectChaptersWithLlm(excerpt, pageCount);
	const errors = validateChapterStarts(proposed, pageCount);
	if (errors.length > 0) throw new Error(`chapter detection failed: ${errors.join("; ")}`);
	return chaptersFromStarts(proposed, pageCount);
}

export async function runBook(book: BookRef, deps: BookRunDeps): Promise<BookResult> {
	const chapters = await detectChapters(deps);
	deps.registerSource?.();
	deps.onChapters?.(chapters);
	const results = await mapPool(chapters, deps.concurrency ?? MAX_PARALLEL_CHAPTERS, (c) => deps.runChapter(c));
	return { book, chapters: chapters.map((chapter, i) => ({ chapter, result: results[i]! })) };
}
