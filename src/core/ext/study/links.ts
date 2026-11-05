// src/core/ext/study/links.ts
/**
 * study-links.jsonl (REQ-study-10): which nodes came from which page of which
 * document. Append-only; nothing here is derived from the content ledgers, so
 * a node that no longer exists is filtered by the caller at read time.
 */

export interface StudyLinkEvent {
	type: "link";
	nodeId: string;
	documentId: string;
	page: number;
	at: string;
}

export interface NodeSource {
	documentId: string;
	page: number;
}

export function parseStudyLinkEvent(raw: unknown): StudyLinkEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "link") return null;
	if (typeof r.nodeId !== "string" || r.nodeId === "" || typeof r.documentId !== "string" || r.documentId === "") return null;
	if (typeof r.page !== "number" || !Number.isInteger(r.page) || r.page < 1) return null;
	if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
	return { type: "link", nodeId: r.nodeId, documentId: r.documentId, page: r.page, at: r.at };
}

/** The (document, page) pairs a node came from: distinct, in order of first appearance. */
export function sourcesOfNode(events: readonly StudyLinkEvent[], nodeId: string): NodeSource[] {
	const seen = new Set<string>();
	const out: NodeSource[] = [];
	for (const e of events) {
		if (e.nodeId !== nodeId) continue;
		const key = `${e.documentId}\u0000${e.page}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ documentId: e.documentId, page: e.page });
	}
	return out;
}

/** Pages of a document that already have at least one node, ascending. */
export function linkedPages(events: readonly StudyLinkEvent[], documentId: string): number[] {
	return [...new Set(events.filter((e) => e.documentId === documentId).map((e) => e.page))].sort((a, b) => a - b);
}

/** Distinct node ids linked to any of the pages. */
export function nodeIdsOnPages(events: readonly StudyLinkEvent[], documentId: string, pages: readonly number[]): string[] {
	const want = new Set(pages);
	return [...new Set(events.filter((e) => e.documentId === documentId && want.has(e.page)).map((e) => e.nodeId))];
}
