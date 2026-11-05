// src/core/ext/study/ports.ts
/** Ports of the assisted-study stage. Adapters live in src/store/ext/, the composition in src/server/ext/stores.ts. */

import { DOCUMENT_ID_RE } from "./documents.ts";

/** The shape of an event ledger (store/ext/ledger.ts createLedger fits it). */
export interface LedgerLike<T> {
	append(event: T): void;
	readAll(): T[];
}

/** The stored copy of each registered PDF and its extracted page texts (data/ext/documents/). */
export interface DocumentFiles {
	/** Writes documents/<sha256>.pdf (idempotent) and returns the id and the stored absolute path. */
	putPdf(bytes: Uint8Array): { id: string; path: string };
	/** Absolute path of the stored copy, or null for an invalid id or a missing file. */
	pdfPath(id: string): string | null;
	/** Writes documents/<id>.pages.json: one string per page, page 1 first. */
	putPages(id: string, pages: readonly string[]): void;
	/** The page texts, or null when absent or unreadable. */
	getPages(id: string): string[] | null;
}

export const isDocumentId = (id: string): boolean => DOCUMENT_ID_RE.test(id);
