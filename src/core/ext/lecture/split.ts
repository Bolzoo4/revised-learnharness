// src/core/ext/lecture/split.ts
/**
 * Lecture split from the chapter OUTLINE, never from page count (REQ-lec-01;
 * teacher doctrine: words per page varies ~36x). Each outline block has an
 * estimated discourse length by kind; blocks are packed in order until a
 * lecture would exceed the target.
 */

export type OutlineKind = "definition" | "theorem" | "example" | "motivation" | "remark";
export interface OutlineBlock {
	title: string;
	kind: OutlineKind;
	summary: string;
}

export const TARGET_WORDS = 2000;
/** Estimated spoken words per block kind (teacher's calibration). */
export const WORDS_BY_KIND: Record<OutlineKind, number> = {
	definition: 150,
	theorem: 375,
	example: 100,
	motivation: 120,
	remark: 80,
};

export function estimatedWords(block: OutlineBlock): number {
	return WORDS_BY_KIND[block.kind];
}

/** Greedy in-order packing. A block alone larger than the target still gets its own lecture. */
export function splitOutline(blocks: readonly OutlineBlock[], target: number = TARGET_WORDS): OutlineBlock[][] {
	const lectures: OutlineBlock[][] = [];
	let current: OutlineBlock[] = [];
	let words = 0;
	for (const block of blocks) {
		const w = estimatedWords(block);
		if (current.length > 0 && words + w > target) {
			lectures.push(current);
			current = [];
			words = 0;
		}
		current.push(block);
		words += w;
	}
	if (current.length > 0) lectures.push(current);
	return lectures;
}
