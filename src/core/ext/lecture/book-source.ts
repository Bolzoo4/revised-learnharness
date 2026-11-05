// src/core/ext/lecture/book-source.ts
/**
 * REQ-lec-02: ingesting a book registers it as an ACTIVE PRIMARY source of the
 * verification stage's library. The user starting the ingest is the act that
 * makes it active (addedBy "user"). Idempotent per PDF path; an existing entry
 * (even a proposed or secondary one) is promoted.
 */

import type { SourceLibrary } from "../sources.ts";

export function registerBookAsPrimary(library: SourceLibrary, pdfPath: string, label: string): void {
	const existing = library.list().find((e) => e.kind === "pdf" && e.locator === pdfPath);
	if (existing === undefined) {
		library.add({ kind: "pdf", locator: pdfPath, tier: "primary", label, addedBy: "user" });
		return;
	}
	if (existing.status !== "active" || existing.tier !== "primary") library.setStatus(existing.id, "active", "primary");
}
