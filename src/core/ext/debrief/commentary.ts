/**
 * @node ext/debrief/commentary
 * The shape of a commentary (REQ-deb-04): four parts, always in the same
 * order under the same headings. The model submits the parts as separate
 * fields, so the structure never depends on how it formats Markdown; code
 * assembles the stored text. A part may not open a heading, close a code
 * fence it did not open, or forge one of the section headers. Pure.
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

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
/** Every character a renderer may treat as a line break. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const HEADING_TEXTS = new Set(Object.values(COMMENTARY_HEADINGS).map((h) => h.toLowerCase()));

/** The problems of one part's text: unclosed fences, headings, and forged section headers. */
function partProblems(part: CommentaryPart, text: string): string[] {
	const problems: string[] = [];
	let fence: string | null = null;
	for (const line of text.split(LINE_BREAK)) {
		if (fence !== null) {
			const close = FENCE_CLOSE.exec(line)?.[1];
			if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = null;
		} else {
			const open = FENCE_OPEN.exec(line)?.[1];
			if (open !== undefined) fence = open;
		}
		if (HEADING.test(line)) problems.push(`${part} contains a heading`);
		const plain = line.trim().replace(/^[#*_>\s]+|[*_:\s]+$/g, "").toLowerCase();
		if (HEADING_TEXTS.has(plain)) problems.push(`${part} repeats a section heading`);
	}
	if (fence !== null) problems.push(`${part} has an unclosed code fence`);
	return problems;
}

/** Problems that make a submission unusable (the writer asks the model to fix them). */
export function checkCommentary(c: Partial<Record<CommentaryPart, unknown>>): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(c)) {
		if (!(COMMENTARY_PARTS as readonly string[]).includes(key)) problems.push(`unknown section ${JSON.stringify(key)}`);
	}
	for (const part of COMMENTARY_PARTS) {
		const v = c[part];
		if (typeof v !== "string" || v.trim() === "") {
			problems.push(`${part} is empty`);
			continue;
		}
		if (v.trim().length > MAX_PART_CHARS) problems.push(`${part} is longer than ${MAX_PART_CHARS} characters`);
		problems.push(...partProblems(part, v));
	}
	return [...new Set(problems)];
}

/** The stored Markdown. Throws when `checkCommentary` finds a problem: an unusable commentary is never rendered. */
export function renderCommentary(c: Commentary): string {
	const problems = checkCommentary(c);
	if (problems.length > 0) throw new Error(`commentary rejected: ${problems.join("; ")}`);
	return COMMENTARY_PARTS.map((p) => `## ${COMMENTARY_HEADINGS[p]}\n\n${c[p].trim().replace(/[\u2028\u2029]/g, " ").replace(/\n{3,}/g, "\n\n")}`).join("\n\n") + "\n";
}
