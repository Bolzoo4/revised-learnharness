// src/server/ext/agent-attachment.ts
/**
 * An attached PDF on its way into the notes pipeline (REQ-graph-agent-12, REQ-02): staged as a private copy, stored
 * like a user upload, read page by page, and given to the notes extractor with a `--- Page N ---` header before each
 * page, the format pdf_extract writes, so the extractor can anchor every proposition to its page. The ports are
 * injected; the live wiring is agent-goals-live.ts.
 */

export interface StagedCopy {
	/** Absolute path of the private copy, valid until release(). */
	path: string;
	release(): Promise<void>;
}

export interface AttachmentPorts {
	stageCopy(bytes: Uint8Array): Promise<StagedCopy>;
	/** Registers the staged copy as a document (as a user upload is) and returns the stored file's path. */
	storeDocument(stagedPath: string): Promise<string>;
	readPages(storedPath: string): Promise<string[]>;
	/** Runs the notes extraction on the text of the stored copy. */
	importNotes(storedPath: string, text: string): Promise<void>;
	sourceIdOf(storedPath: string): string;
}

/** The pages joined with a `--- Page N ---` header each, page 1 first. */
export function withPageMarkers(pages: readonly string[]): string {
	return pages.map((text, i) => `--- Page ${i + 1} ---\n${text}`).join("\n");
}

/** Stores the attached PDF, extracts its notes from the paged text, and releases the staged copy on every path. */
export async function importAttachedPdf(bytes: Uint8Array, ports: AttachmentPorts): Promise<{ sourceId: string }> {
	const staged = await ports.stageCopy(bytes);
	try {
		const storedPath = await ports.storeDocument(staged.path);
		const pages = await ports.readPages(storedPath);
		await ports.importNotes(storedPath, withPageMarkers(pages));
		return { sourceId: ports.sourceIdOf(storedPath) };
	} finally {
		await staged.release().catch(() => undefined);
	}
}
