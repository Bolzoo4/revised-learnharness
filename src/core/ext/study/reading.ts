// src/core/ext/study/reading.ts
/**
 * reading.jsonl (REQ-study-03). Events are page movements:
 *   visit {documentId, page, at}  the learner arrived on a page
 *   close {documentId, at}        the learner left the document
 * Derived state: the last page visited (restored when the document opens) and
 * the set of pages READ. A visit lasts until the next event of the same
 * document (a visit or a close); a page is read when some visit to it lasted
 * at least the dwell time. The newest visit has no end yet, so it counts as
 * read only once another event follows it.
 */

export const DEFAULT_DWELL_SECONDS = 5;

export type ReadingEvent =
	| { type: "visit"; documentId: string; page: number; at: string }
	| { type: "close"; documentId: string; at: string };

export interface ReadingState {
	/** Page of the newest visit; null when the document was never opened. */
	lastPage: number | null;
	/** Ascending, distinct. */
	readPages: number[];
}

export function parseReadingEvent(raw: unknown): ReadingEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "close") return { type: "close", documentId: r.documentId, at: r.at };
	if (r.type === "visit") {
		if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) return null;
		return { type: "visit", documentId: r.documentId, page: r.page, at: r.at };
	}
	return null;
}

export function deriveReading(
	events: readonly ReadingEvent[],
	documentId: string,
	opts: { dwellSeconds?: number; pageCount?: number } = {},
): ReadingState {
	const dwellMs = (opts.dwellSeconds ?? DEFAULT_DWELL_SECONDS) * 1000;
	const inRange = (page: number): boolean => opts.pageCount === undefined || page <= opts.pageCount;
	const read = new Set<number>();
	let lastPage: number | null = null;
	let open: { page: number; at: number } | null = null;
	for (const e of events) {
		if (e.documentId !== documentId) continue;
		const at = Date.parse(e.at);
		if (open !== null && at - open.at >= dwellMs && inRange(open.page)) read.add(open.page);
		if (e.type === "visit") {
			open = { page: e.page, at };
			lastPage = e.page;
		} else {
			open = null;
		}
	}
	return { lastPage: lastPage !== null && inRange(lastPage) ? lastPage : null, readPages: [...read].sort((a, b) => a - b) };
}
