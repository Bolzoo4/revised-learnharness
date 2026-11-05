// src/agent/ext/lecture/pdf-facts.ts
/**
 * What the chapter run needs from a PDF beyond upstream's pdf-ops: the
 * bookmarks (outline) and the plain text of a page range. Uses the same
 * pdfjs build and font setup as pdf-ops.
 */

import * as fs from "node:fs/promises";
import { normalizeBookmarks, plainChapterText, type Chapter, type ChapterStart } from "../../../core/ext/lecture/chapters.ts";
import { pdfExtract, standardFontsDir } from "../../subagents/pdf-ops.ts";

async function open(pdfPath: string) {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const data = new Uint8Array(await fs.readFile(pdfPath));
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	return { doc: await task.promise, task };
}

interface OutlineItem {
	title: string;
	dest: unknown;
	items: OutlineItem[];
}

/** The chapter-level bookmarks: the top level, or the level below when the top level is only a few "Part" entries. */
export async function readBookmarks(pdfPath: string): Promise<{ pageCount: number; bookmarks: ChapterStart[] }> {
	const { doc, task } = await open(pdfPath);
	try {
		const outline = (await doc.getOutline()) as OutlineItem[] | null;
		let level: OutlineItem[] = outline ?? [];
		if (level.length < 3) {
			const next = level.flatMap((i) => i.items);
			if (next.length >= 3) level = next;
		}
		const found: ChapterStart[] = [];
		for (const item of level) {
			let dest = item.dest;
			if (typeof dest === "string") dest = await doc.getDestination(dest);
			if (!Array.isArray(dest) || dest.length === 0) continue;
			const target: unknown = dest[0];
			let pageIndex: number;
			if (typeof target === "number") pageIndex = target;
			else {
				try {
					pageIndex = await doc.getPageIndex(target as { num: number; gen: number });
				} catch {
					continue;
				}
			}
			found.push({ title: item.title, page: pageIndex + 1 });
		}
		return { pageCount: doc.numPages, bookmarks: normalizeBookmarks(found) };
	} finally {
		await task.destroy();
	}
}

/** Text of every page, for the no-bookmarks fallback excerpt (cheap: plain text items). */
export async function readPageTexts(pdfPath: string): Promise<string[]> {
	const { doc, task } = await open(pdfPath);
	try {
		const pages: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const content = await (await doc.getPage(i)).getTextContent();
			let text = "";
			for (const item of content.items) {
				if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
			}
			pages.push(text);
		}
		return pages;
	} finally {
		await task.destroy();
	}
}

/** The plain text of one chapter, via the math-aware extraction pdf-ops uses everywhere else. */
export async function readChapterText(pdfPath: string, chapter: Chapter): Promise<string> {
	return plainChapterText(await pdfExtract(pdfPath, `${chapter.pageStart}-${chapter.pageEnd}`));
}
