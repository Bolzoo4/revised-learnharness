// components/ext/exams-logic.ts
/**
 * Pure helpers of the Exams pages: the split point, the merge rule, the page span
 * label and the practice gate. No DOM, no fetch: the pages call these and the
 * tests pin them.
 */

export const SPLIT_NEEDS_CURSOR = "Put the cursor inside the exercise text, between two parts, then choose Split here.";
export const SPLIT_EMPTY_PART = "Both parts need some text: move the cursor to a point inside the text.";

export type SplitChoice = { ok: true; at: number } | { ok: false; error: string };

/**
 * The offset to split an exercise at: the text cursor (selectionStart), which must
 * sit strictly inside the text and leave some non-blank text on both sides.
 * Offsets are JavaScript string indexes (UTF-16 code units), the same units the
 * service's split operation uses.
 */
export function splitChoice(text: string, at: number | null): SplitChoice {
	if (at === null) return { ok: false, error: SPLIT_NEEDS_CURSOR };
	if (!Number.isInteger(at) || at <= 0 || at >= text.length) return { ok: false, error: SPLIT_EMPTY_PART };
	if (text.slice(0, at).trim() === "" || text.slice(at).trim() === "") return { ok: false, error: SPLIT_EMPTY_PART };
	return { ok: true, at };
}

/** Merge with next is possible for every exercise but the last one in the list. */
export function canMergeWithNext(index: number, count: number): boolean {
	return index >= 0 && index < count - 1;
}

/** "p. 4" for one page, "pp. 4–6" for a run of pages. */
export function pageSpan(e: { pageStart: number; pageEnd: number }): string {
	return e.pageStart === e.pageEnd ? `p. ${e.pageStart}` : `pp. ${e.pageStart}–${e.pageEnd}`;
}

/** Practice opens only once the learner has reviewed the exercise list of the exam (REQ-ex-03). */
export function practiceEnabled(reviewed: boolean): boolean {
	return reviewed;
}

/** A collection needs a title with something in it. */
export function collectionTitleValid(title: string): boolean {
	return title.trim() !== "";
}
