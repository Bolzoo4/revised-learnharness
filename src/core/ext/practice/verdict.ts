// src/core/ext/practice/verdict.ts
/**
 * Source-anchored verdicts (REQ-lec-14, REQ-ver-04). The model only PROPOSES
 * comparison items; code decides what survives. An item survives when its
 * quotation from the designated source occurs in the source text (the
 * verification stage's checkQuote: normalization, minimum length) and, for
 * `matches` / `differs`, its quotation of the student's work occurs in the
 * work. With nothing surviving the answer is "not_verifiable": the model's own
 * judgment is never the verdict.
 */

import { checkQuote, normalizeForMatch } from "../quote.ts";

/** matches: the work says what the source step says. differs: the work states something else for that step. missing: the work has no counterpart. */
export type VerdictStance = "matches" | "differs" | "missing";

export interface VerdictItem {
	/** The reference step this item is about (a step id for exercises; any short label for a plain source). */
	stepRef: string;
	/** Verbatim from the designated source. */
	sourceQuote: string;
	/** Verbatim from the student's work; empty for `missing`. */
	workQuote: string;
	stance: VerdictStance;
}

export type VerdictDiscard = "quote_not_found" | "quote_too_short" | "work_quote_not_found";
export type VerdictOutcome = "consistent" | "differs" | "not_verifiable";

const STANCES = new Set<string>(["matches", "differs", "missing"]);

/** Structural parse of one model item; null when malformed. */
export function parseVerdictItem(raw: unknown): VerdictItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.stepRef !== "string" || r.stepRef === "" || typeof r.sourceQuote !== "string") return null;
	if (typeof r.workQuote !== "string" || typeof r.stance !== "string" || !STANCES.has(r.stance)) return null;
	return { stepRef: r.stepRef, sourceQuote: r.sourceQuote, workQuote: r.workQuote, stance: r.stance as VerdictStance };
}

const contains = (haystack: string, needle: string): boolean => {
	const n = normalizeForMatch(needle, "join");
	return n !== "" && normalizeForMatch(haystack, "join").includes(n);
};

export function checkVerdictItems(
	items: readonly VerdictItem[],
	source: string,
	work: string,
): { kept: VerdictItem[]; discarded: Array<{ stepRef: string; reason: VerdictDiscard }> } {
	const kept: VerdictItem[] = [];
	const discarded: Array<{ stepRef: string; reason: VerdictDiscard }> = [];
	for (const item of items) {
		const q = checkQuote(source, item.sourceQuote);
		if (q !== "ok") {
			discarded.push({ stepRef: item.stepRef, reason: q });
			continue;
		}
		if (item.stance !== "missing" && !contains(work, item.workQuote)) {
			discarded.push({ stepRef: item.stepRef, reason: "work_quote_not_found" });
			continue;
		}
		kept.push(item);
	}
	return { kept, discarded };
}

/** Nothing surviving: not_verifiable. Every survivor matches: consistent. Otherwise: differs. */
export function verdictOutcome(kept: readonly VerdictItem[]): VerdictOutcome {
	if (kept.length === 0) return "not_verifiable";
	return kept.every((i) => i.stance === "matches") ? "consistent" : "differs";
}

export const OUTCOME_TEXT: Record<VerdictOutcome, string> = {
	consistent: "On the steps checked, the work is consistent with the designated source. This is a comparison with that source, not a proof of correctness.",
	differs: "The work differs from the designated source at the steps listed below.",
	not_verifiable: "Not verifiable: nothing could be confirmed against a designated source.",
};
