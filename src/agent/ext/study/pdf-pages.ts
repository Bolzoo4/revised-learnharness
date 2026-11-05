// src/agent/ext/study/pdf-pages.ts
/**
 * The text of every page of a PDF, one string per page (page 1 first), through
 * upstream's math-aware extraction (pdf-ops pdfExtract, the same text the
 * verification stage's quote check reads). A page with no text (a scan or a
 * figure) is the empty string.
 */

import { pdfExtract } from "../../subagents/pdf-ops.ts";

const HEADER = /^--- Page (\d+) ---\n?/gm;

/** Splits pdfExtract's `--- Page N ---` output. Pages must come numbered 1..n in order. */
export function splitExtractedPages(markdown: string): string[] {
	const heads = [...markdown.matchAll(HEADER)];
	const pages: string[] = [];
	for (const [i, head] of heads.entries()) {
		if (Number(head[1]) !== i + 1) throw new Error(`pdf pages: expected page ${i + 1}, found page ${head[1]}`);
		const start = head.index + head[0].length;
		const end = i + 1 < heads.length ? heads[i + 1]!.index : markdown.length;
		pages.push(markdown.slice(start, end).replace(/\n$/, ""));
	}
	return pages;
}

export async function readDocumentPages(pdfPath: string): Promise<{ pageCount: number; pages: string[] }> {
	const pages = splitExtractedPages(await pdfExtract(pdfPath, "all"));
	if (pages.length === 0) throw new Error("pdf pages: the PDF has no pages");
	return { pageCount: pages.length, pages };
}
