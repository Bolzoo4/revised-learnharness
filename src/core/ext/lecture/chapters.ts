// src/core/ext/lecture/chapters.ts
/**
 * Chapters of a book (REQ-lec-01): from PDF bookmarks, or from an LLM guess
 * validated by the same rules. Pure. Pages are 1-based and inclusive.
 */

export interface ChapterStart {
	title: string;
	page: number;
}
export interface Chapter {
	/** 1-based. */
	index: number;
	title: string;
	pageStart: number;
	pageEnd: number;
}

/** Problems with a proposed chapter list; empty = usable. */
export function validateChapterStarts(starts: readonly ChapterStart[], pageCount: number): string[] {
	const errors: string[] = [];
	if (starts.length === 0) errors.push("no chapters proposed");
	starts.forEach((s, i) => {
		if (s.title.trim() === "") errors.push(`chapter ${i + 1} has an empty title`);
		if (!Number.isInteger(s.page) || s.page < 1 || s.page > pageCount) errors.push(`chapter "${s.title}" starts at page ${s.page}, outside 1..${pageCount}`);
		const prev = starts[i - 1];
		if (prev !== undefined && s.page <= prev.page) errors.push(`chapter "${s.title}" does not start after "${prev.title}" (pages must strictly increase)`);
	});
	return errors;
}

/** Each chapter runs to the page before the next one; the last to the end of the book. Input must be valid. */
export function chaptersFromStarts(starts: readonly ChapterStart[], pageCount: number): Chapter[] {
	return starts.map((s, i) => ({
		index: i + 1,
		title: s.title.trim(),
		pageStart: s.page,
		pageEnd: i + 1 < starts.length ? starts[i + 1]!.page - 1 : pageCount,
	}));
}

/** Bookmarks arrive in outline order and may repeat a page (a chapter and its first section). Keep the first per page, drop out-of-order ones. */
export function normalizeBookmarks(raw: readonly ChapterStart[]): ChapterStart[] {
	const out: ChapterStart[] = [];
	for (const b of raw) {
		const prev = out[out.length - 1];
		if (b.title.trim() === "") continue;
		if (prev !== undefined && b.page <= prev.page) continue;
		out.push({ title: b.title.trim(), page: b.page });
	}
	return out;
}

/** The excerpt the LLM fallback sees: first pages whole, then the first line of every other page. */
export function buildChapterDetectExcerpt(pages: readonly string[], wholePages: number = 6): string {
	const parts: string[] = [];
	pages.forEach((text, i) => {
		const n = i + 1;
		if (n <= wholePages) {
			parts.push(`===== PAGE ${n} =====\n${text.trim()}`);
			return;
		}
		const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
		if (first !== undefined) parts.push(`[page ${n}] ${first}`);
	});
	return parts.join("\n");
}

/** Plain text of pdfExtract's markdown: the `--- Page N ---` headers removed. */
export function plainChapterText(markdown: string): string {
	return markdown.replace(/^--- Page \d+ ---\n?/gm, "").trim();
}
