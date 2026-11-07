// src/core/ext/exams/chunker.ts
/**
 * Material chunks (REQ-ex-04, REQ-ex-05): each chunk stays on one page, so a retrieved
 * passage always carries a page number. Paragraphs (blank-line separated) are packed
 * up to a size; a paragraph longer than the size is cut at a space near the limit.
 * A page with no text yields no chunk.
 */

export const DEFAULT_CHUNK_CHARS = 1200;

export interface PageChunk {
	page: number;
	text: string;
}

function cutLong(text: string, max: number): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let at = rest.lastIndexOf(" ", max);
		if (at <= 0) at = max;
		parts.push(rest.slice(0, at).trim());
		rest = rest.slice(at).trim();
	}
	if (rest !== "") parts.push(rest);
	return parts;
}

/** The chunks of one page's text (no page number applied yet). */
function chunksOfPage(text: string, max: number): string[] {
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => p !== "")
		.flatMap((p) => (p.length > max ? cutLong(p, max) : [p]));
	const out: string[] = [];
	let buf = "";
	for (const p of paragraphs) {
		if (buf !== "" && buf.length + 2 + p.length > max) {
			out.push(buf);
			buf = p;
		} else {
			buf = buf === "" ? p : `${buf}\n\n${p}`;
		}
	}
	if (buf !== "") out.push(buf);
	return out;
}

/** Chunks of every page, page 1 first. `pages[i]` is page i+1. */
export function chunkPages(pages: readonly string[], maxChars: number = DEFAULT_CHUNK_CHARS): PageChunk[] {
	const out: PageChunk[] = [];
	pages.forEach((text, i) => {
		for (const chunk of chunksOfPage(text, maxChars)) out.push({ page: i + 1, text: chunk });
	});
	return out;
}
