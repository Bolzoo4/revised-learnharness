/**
 * Clickable page citations (REQ-study-07). The agent writes `(p. N)` as plain
 * text; the study view finds the citation under a click from the caret
 * position, so no change to how upstream renders messages is needed.
 */

import { citationAt } from "@/src/core";

/** The page cited at a caret position inside a text node, or null. A click on the right half of the closing parenthesis puts the caret just after it, so the previous character counts too. */
export function pageAtCaret(node: { nodeType: number; textContent: string | null } | null, offset: number): number | null {
	if (node === null || node.nodeType !== 3) return null;
	const text = node.textContent ?? "";
	return citationAt(text, offset) ?? (offset > 0 ? citationAt(text, offset - 1) : null);
}

/** The page cited under a viewport point, or null. */
export function pageFromPoint(doc: Document, x: number, y: number): number | null {
	const range = doc.caretRangeFromPoint?.(x, y);
	return range ? pageAtCaret(range.startContainer, range.startOffset) : null;
}
