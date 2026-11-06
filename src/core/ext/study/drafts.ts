// src/core/ext/study/drafts.ts
/**
 * study-drafts.jsonl (REQ-study-11, REQ-study-12): what the "complete" run
 * proposes. Draft nodes cannot live in the content graph (only the extraction
 * pipeline writes it), so a proposal is an event here until the learner
 * approves it; only approval sends the proposition to the pipeline.
 *
 *   proposed        {draftId, documentId, page, proposition, question, answer, at}
 *   decided         {draftId, decision: approved | rejected, at}
 *   pages_processed {documentId, pages, at}   pages a complete run has handled
 */

import { normalizeForMatch } from "../quote.ts";
import { MAX_PAGE, MAX_TEXT_CHARS, flattenText } from "./bounds.ts";

export type DraftEvent =
	| {
			type: "proposed";
			draftId: string;
			documentId: string;
			page: number;
			proposition: string;
			question: string;
			answer: string;
			at: string;
	  }
	| { type: "decided"; draftId: string; decision: "approved" | "rejected"; at: string }
	| { type: "pages_processed"; documentId: string; pages: number[]; at: string };

export type DraftStatus = "pending" | "approved" | "rejected";

export interface Draft {
	id: string;
	documentId: string;
	page: number;
	proposition: string;
	question: string;
	answer: string;
	status: DraftStatus;
	proposedAt: string;
}

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const validAt = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isPage = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PAGE;

export function parseDraftEvent(raw: unknown): DraftEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!validAt(r.at)) return null;
	if (r.type === "proposed") {
		if (!nonBlank(r.draftId) || !nonBlank(r.documentId) || !isPage(r.page)) return null;
		if (!nonBlank(r.proposition) || !nonBlank(r.question) || !nonBlank(r.answer)) return null;
		return {
			type: "proposed",
			draftId: r.draftId,
			documentId: r.documentId,
			page: r.page,
			proposition: flattenText(r.proposition, MAX_TEXT_CHARS),
			question: flattenText(r.question, MAX_TEXT_CHARS),
			answer: flattenText(r.answer, MAX_TEXT_CHARS),
			at: r.at,
		};
	}
	if (r.type === "decided") {
		if (!nonBlank(r.draftId) || (r.decision !== "approved" && r.decision !== "rejected")) return null;
		return { type: "decided", draftId: r.draftId, decision: r.decision, at: r.at };
	}
	if (r.type === "pages_processed") {
		if (!nonBlank(r.documentId) || !Array.isArray(r.pages) || r.pages.length === 0 || !r.pages.every(isPage)) return null;
		return { type: "pages_processed", documentId: r.documentId, pages: [...r.pages] as number[], at: r.at };
	}
	return null;
}

/** Replay in file order. The first `proposed` per id defines the draft; the first `decided` wins; `decided` for an unknown draft is ignored. */
export function deriveDrafts(events: readonly DraftEvent[]): Draft[] {
	const drafts = new Map<string, Draft>();
	const decided = new Set<string>();
	for (const e of events) {
		if (e.type === "proposed") {
			if (drafts.has(e.draftId)) continue;
			drafts.set(e.draftId, {
				id: e.draftId,
				documentId: e.documentId,
				page: e.page,
				proposition: e.proposition,
				question: e.question,
				answer: e.answer,
				status: "pending",
				proposedAt: e.at,
			});
		} else if (e.type === "decided") {
			const d = drafts.get(e.draftId);
			if (d === undefined || decided.has(e.draftId)) continue;
			decided.add(e.draftId);
			d.status = e.decision;
		}
	}
	return [...drafts.values()];
}

/** Pages a complete run has handled for a document, ascending and distinct. */
export function processedPages(events: readonly DraftEvent[], documentId: string): number[] {
	const pages = new Set<number>();
	for (const e of events) if (e.type === "pages_processed" && e.documentId === documentId) for (const p of e.pages) pages.add(p);
	return [...pages].sort((a, b) => a - b);
}

/**
 * The comparison key of a proposition: normalized, then without trailing full
 * stops and spaces. Scanned from the end, so it is linear in the length.
 */
function propositionKey(s: string): string {
	const t = normalizeForMatch(s, "join");
	let end = t.length;
	while (end > 0 && (t.charCodeAt(end - 1) === 46 || /\s/.test(t[end - 1]!))) end--;
	return t.slice(0, end);
}

/** Two propositions are the same when they match after normalization and without a final full stop. */
export function sameProposition(a: string, b: string): boolean {
	return propositionKey(a) === propositionKey(b);
}

/**
 * Drops candidates that repeat something that already exists (REQ-study-11:
 * skip what is already there) or an earlier kept candidate, then keeps at most
 * `perPage` per page, in the order given. Each string is normalized once and
 * matched through a Set, so the cost is linear in the total size.
 */
export function dropRepeats<T extends { page: number; proposition: string }>(
	candidates: readonly T[],
	existing: readonly string[],
	perPage: number,
): T[] {
	const known = new Set(existing.map(propositionKey));
	const kept: T[] = [];
	const perPageCount = new Map<number, number>();
	for (const c of candidates) {
		const key = propositionKey(c.proposition);
		if (known.has(key)) continue;
		const n = perPageCount.get(c.page) ?? 0;
		if (n >= perPage) continue;
		perPageCount.set(c.page, n + 1);
		known.add(key);
		kept.push(c);
	}
	return kept;
}
