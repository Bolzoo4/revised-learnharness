// src/core/ext/explanation-check.ts
/**
 * Deterministic checks and link handling for explanations (REQ-node-07,
 * REQ-node-08, REQ-node-15). Pure and browser-safe (no node: imports): the
 * panel uses extractNodeLinks/linkifyNodeLinks on the client too.
 *
 * Errors BLOCK a text (unresolved link, placeholder, empty). Warnings never
 * block (sentence length), because rigid length rules would harm
 * intuition-first explanations.
 */

/** One limit for every language until a real case needs a table. */
export const MAX_SENTENCE_WORDS = 25;

/** href prefix of a rendered node link; the panel intercepts clicks on it. */
export const NODE_HREF_PREFIX = "#node:";

const linkPattern = () => /\[\[([^\[\]\s]+)\]\]/g;
const PLACEHOLDER_CAPS = /\b(?:TODO|TBD|FIXME|XXX)\b/;
const PLACEHOLDER_TEXT = /lorem ipsum|\[\.\.\.\]|\[insert[^\]]*\]|<placeholder>/i;

export interface ExplanationCheck {
	errors: string[];
	warnings: string[];
}

/** Each linked node id once, in order of first appearance. */
export function extractNodeLinks(body: string): string[] {
	const out: string[] = [];
	for (const match of body.matchAll(linkPattern())) {
		const id = match[1];
		if (id !== undefined && !out.includes(id)) out.push(id);
	}
	return out;
}

/** Prose only: code, formulas, headings and list markers removed; a link counts as one word. */
function prose(body: string): string {
	return body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\$\$[\s\S]*?\$\$/g, " formula ")
		.replace(/\$[^$\n]+\$/g, " formula ")
		.replace(linkPattern(), "link")
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n")
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
}

function sentencesOf(body: string): string[] {
	return prose(body)
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

export function checkExplanation(
	body: string,
	validIds: ReadonlySet<string>,
	maxSentenceWords: number = MAX_SENTENCE_WORDS,
): ExplanationCheck {
	if (!Number.isInteger(maxSentenceWords) || maxSentenceWords < 1) {
		throw new RangeError(`checkExplanation: maxSentenceWords must be a positive integer, got ${maxSentenceWords}`);
	}
	if (body.trim() === "") return { errors: ["the explanation is empty"], warnings: [] };
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const id of extractNodeLinks(body)) {
		if (!validIds.has(id)) errors.push(`link [[${id}]] does not resolve to an existing node`);
	}
	if (PLACEHOLDER_CAPS.test(body) || PLACEHOLDER_TEXT.test(body)) errors.push("the explanation contains a placeholder");
	for (const sentence of sentencesOf(body)) {
		const count = sentence.split(/\s+/).filter((w) => w !== "").length;
		if (count > maxSentenceWords) {
			warnings.push(`sentence of ${count} words (limit ${maxSentenceWords}): "${sentence.slice(0, 50)}"`);
		}
	}
	return { errors, warnings };
}

/**
 * Back-links: ids of the nodes whose CURRENT explanation links to `nodeId`.
 * Derived on every call from the bodies, never stored. Sorted, no self.
 */
export function mentionedBy(nodeId: string, currentBodies: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	for (const [id, body] of currentBodies) {
		if (id !== nodeId && extractNodeLinks(body).includes(nodeId)) out.push(id);
	}
	return out.sort();
}

/** Render `[[id]]` as a markdown link `[name](#node:id)`; unknown ids become "(unknown node)". */
export function linkifyNodeLinks(body: string, names: Readonly<Record<string, string>>): string {
	return body.replace(linkPattern(), (_match, id: string) => {
		if (!Object.hasOwn(names, id)) return "(unknown node)";
		const name = (names[id] ?? id).replace(/[\[\]]/g, "");
		return `[${name}](${NODE_HREF_PREFIX}${id})`;
	});
}
