// src/core/ext/study/documents.ts
/**
 * documents.jsonl (REQ-study-01, REQ-study-05): registered PDFs and the one
 * conversation bound to each. Server-side module (not in the browser barrel).
 *
 * Event `registered`: the document's identity is the sha256 of the file, so
 * the same file registered twice is the same document (the first event wins).
 * Event `chat`: binds the document's study conversation; the first one wins,
 * which is what makes the conversation unique per document.
 */

import { MAX_PAGE, MAX_TITLE_CHARS, flattenText } from "./bounds.ts";

export const DOCUMENT_ID_RE = /^[0-9a-f]{64}$/;

export type DocumentEvent =
	| { type: "registered"; documentId: string; title: string; pageCount: number; at: string }
	| { type: "chat"; documentId: string; chatId: string; at: string };

export interface StudyDocument {
	id: string;
	title: string;
	pageCount: number;
	registeredAt: string;
	/** The document's conversation, or null until it is first opened. */
	chatId: string | null;
}

const validAt = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function parseDocumentEvent(raw: unknown): DocumentEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.documentId !== "string" || !DOCUMENT_ID_RE.test(r.documentId) || !validAt(r.at)) return null;
	if (r.type === "registered") {
		if (typeof r.title !== "string") return null;
		const title = flattenText(r.title, MAX_TITLE_CHARS);
		if (title === "") return null;
		if (typeof r.pageCount !== "number" || !Number.isInteger(r.pageCount) || r.pageCount < 1 || r.pageCount > MAX_PAGE) return null;
		return { type: "registered", documentId: r.documentId, title, pageCount: r.pageCount, at: r.at };
	}
	if (r.type === "chat") {
		if (typeof r.chatId !== "string" || r.chatId === "") return null;
		return { type: "chat", documentId: r.documentId, chatId: r.chatId, at: r.at };
	}
	return null;
}

/** Replay in file order. A `chat` event for an unregistered document is ignored. */
export function deriveDocuments(events: readonly DocumentEvent[]): StudyDocument[] {
	const docs = new Map<string, StudyDocument>();
	for (const e of events) {
		if (e.type === "registered") {
			if (!docs.has(e.documentId)) {
				docs.set(e.documentId, { id: e.documentId, title: e.title, pageCount: e.pageCount, registeredAt: e.at, chatId: null });
			}
			continue;
		}
		const doc = docs.get(e.documentId);
		if (doc !== undefined && doc.chatId === null) doc.chatId = e.chatId;
	}
	return [...docs.values()];
}

/** The document a study conversation belongs to, or null. */
export function documentOfChat(docs: readonly StudyDocument[], chatId: string): StudyDocument | null {
	return docs.find((d) => d.chatId === chatId) ?? null;
}
