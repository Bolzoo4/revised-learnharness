// src/core/ext/mcp/documents.ts
/** list_documents (REQ-mcp-14): registered PDFs with title, page count and reading progress. No file path, no chat id. */

import { deriveDocuments } from "../study/documents.ts";
import { deriveReading } from "../study/reading.ts";
import type { Call } from "./call.ts";
import { capText, LIMITS, page, round4 } from "./limits.ts";

export function listDocuments(call: Call) {
	const events = call.deps.reading.readAll();
	const docs = deriveDocuments(call.deps.documents.readAll()).sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : a.registeredAt > b.registeredAt ? -1 : a.id < b.id ? -1 : 1));
	const p = page(docs, LIMITS.documentsMax);
	return {
		...p,
		items: p.items.map((d) => {
			const reading = deriveReading(events, d.id, { pageCount: d.pageCount });
			return {
				id: d.id,
				title: capText(d.title, LIMITS.titleChars),
				pageCount: d.pageCount,
				registeredAt: d.registeredAt,
				lastPage: reading.lastPage,
				readPages: reading.readPages.length,
				readShare: round4(reading.readPages.length / d.pageCount),
			};
		}),
	};
}
