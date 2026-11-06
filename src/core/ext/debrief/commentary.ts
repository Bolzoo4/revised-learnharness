// src/core/ext/debrief/commentary.ts
/**
 * @node ext/debrief/commentary
 * The shape of a commentary (REQ-deb-04): four parts, always in the same
 * order under the same headings. The model submits the parts as separate
 * fields, so the structure never depends on how it formats Markdown; code
 * assembles the stored text. Pure.
 */

export const COMMENTARY_PARTS = ["observations", "stateOfLearning", "critique", "suggestion"] as const;
export type CommentaryPart = (typeof COMMENTARY_PARTS)[number];
export type Commentary = Record<CommentaryPart, string>;

export const COMMENTARY_HEADINGS: Record<CommentaryPart, string> = {
	observations: "Observations",
	stateOfLearning: "State of learning",
	critique: "Critique",
	suggestion: "Suggestion for the next session",
};

export const MAX_PART_CHARS = 2500;

/** Problems that make a submission unusable (the writer asks the model to fix them). */
export function checkCommentary(c: Partial<Record<CommentaryPart, unknown>>): string[] {
	const problems: string[] = [];
	for (const part of COMMENTARY_PARTS) {
		const v = c[part];
		if (typeof v !== "string" || v.trim() === "") problems.push(`${part} is empty`);
		else if (v.trim().length > MAX_PART_CHARS) problems.push(`${part} is longer than ${MAX_PART_CHARS} characters`);
	}
	return problems;
}

/** A part may not open its own headings: they would split the structure. */
const cleanPart = (text: string): string => text.trim().replace(/^#{1,6}\s+/gm, "").replace(/\n{3,}/g, "\n\n");

/** The stored Markdown. Throws when `checkCommentary` finds a problem: an unusable commentary is never rendered. */
export function renderCommentary(c: Commentary): string {
	const problems = checkCommentary(c);
	if (problems.length > 0) throw new Error(`commentary rejected: ${problems.join("; ")}`);
	return COMMENTARY_PARTS.map((p) => `## ${COMMENTARY_HEADINGS[p]}\n\n${cleanPart(c[p])}`).join("\n\n") + "\n";
}
