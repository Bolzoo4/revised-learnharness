// src/core/ext/lecture/graph-parts.ts
/**
 * The parts a chapter's graph is imported in (pure). Each part is imported on
 * its own and checkpointed, so a retry resumes after the last complete part
 * instead of re-reading the whole chapter. A part is kept well under the notes
 * pipeline's chunk budget (4096 tokens), so one part is one chunk in practice.
 */

export const GRAPH_PART_CHARS = 8000;

/** Splits on blank lines, packs paragraphs up to maxChars, hard-splits a paragraph longer than maxChars at a space. Deterministic. */
export function splitForGraphImport(text: string, maxChars: number = GRAPH_PART_CHARS): string[] {
	const pieces: string[] = [];
	for (const paragraph of text.split(/\n\s*\n/)) {
		const p = paragraph.trim();
		if (p === "") continue;
		if (p.length <= maxChars) pieces.push(p);
		else pieces.push(...hardSplit(p, maxChars));
	}
	const parts: string[] = [];
	let current = "";
	for (const piece of pieces) {
		if (current === "") current = piece;
		else if (current.length + 2 + piece.length <= maxChars) current += `\n\n${piece}`;
		else {
			parts.push(current);
			current = piece;
		}
	}
	if (current !== "") parts.push(current);
	return parts;
}

function hardSplit(text: string, maxChars: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const space = rest.lastIndexOf(" ", maxChars);
		const cut = space > 0 ? space : maxChars;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest !== "") out.push(rest);
	return out;
}
