// src/core/ext/practice/session-kind.ts
/**
 * Sessions that write nothing to the graph and compact like practice:
 * `practice` plus the extension's `review` and `office_hours` kinds.
 * The single definition; layers import it instead of re-testing the kinds.
 */
export const isPracticeLike = (kind: string | undefined): boolean =>
	kind === "practice" || kind === "review" || kind === "office_hours" || kind === "research";
