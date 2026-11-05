// src/core/ext/study/source-path.ts
/**
 * The identity of a confirmed proposition as a notes source. The extraction
 * pipeline's front door (importNotes) keys a source by its file path, so each
 * proposition gets its own pseudo-path: stable for the same document, page and
 * text (re-confirming the same proposition re-runs against the same source),
 * different for any other. The path is never read from disk.
 */

import { createHash } from "node:crypto";

export function slugOf(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug === "" ? "document" : slug;
}

export function studySourcePath(title: string, page: number, proposition: string): string {
	const digest = createHash("sha256").update(proposition.trim(), "utf8").digest("hex").slice(0, 8);
	return `study/${slugOf(title)}/p${String(page).padStart(4, "0")}-${digest}.md`;
}

/** The text handed to the pipeline: the proposition alone, so nothing else can be extracted from it. */
export function studySourceText(proposition: string): string {
	return `${proposition.trim()}\n`;
}
