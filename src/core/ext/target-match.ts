// src/core/ext/target-match.ts
/**
 * The cheap identity pass for goal targets (REQ-graph-agent-27). Pure: a target statement is the same node as an
 * existing one when its normalised text equals the normalised name, alias or statement of that node. Anything
 * that is not exactly equal goes on to the model judgement (the auditor), which decides.
 */

/** Lowercase, accents and punctuation removed, runs of other characters collapsed to one space. */
export function normalizeText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export interface MatchableNode {
	id: string;
	name: string;
	statement: string;
	aliases: readonly string[];
}

/** The id of the first node whose name, statement or an alias normalises to the target's normalised text, or null. */
export function matchExistingNode(statement: string, nodes: readonly MatchableNode[]): string | null {
	const target = normalizeText(statement);
	if (target === "") return null;
	for (const node of nodes) {
		const texts = [node.name, node.statement, ...node.aliases];
		if (texts.some((text) => normalizeText(text) === target)) return node.id;
	}
	return null;
}
