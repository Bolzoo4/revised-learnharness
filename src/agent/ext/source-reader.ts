// src/agent/ext/source-reader.ts
/**
 * Re-reads a source for the snapshot. The model's view of a source is never
 * trusted: this reader fetches again with upstream's own tools, so the text a
 * quote is checked against is text CODE obtained. Local files are read only if
 * they are active library PDFs (the caller supplies the allow-list).
 * `web_fetch` truncates pages at 40,000 characters; the verifier saw the same
 * truncation, so a quote beyond it is unverifiable by design.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceTextReader } from "../../core/ext/ports.ts";
import { pdfExtract } from "../subagents/pdf-ops.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { createWebTools } from "../tools/web.ts";

function stripPageMarkers(text: string): string {
	return text.replace(/^--- Page \d+ ---$/gm, "");
}

async function readLocalPdf(file: string): Promise<string | null> {
	try {
		return stripPageMarkers(await pdfExtract(file, "all"));
	} catch {
		return null;
	}
}

async function readRemotePdf(url: string): Promise<string | null> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-verify-pdf-"));
	try {
		const out = await createPdfReadTools(dir).web_fetch_pdf!.execute!("verify-pdf", { url });
		const details = out.details as { path?: unknown } | string | undefined;
		if (typeof details !== "object" || details === null || typeof details.path !== "string") return null;
		return await readLocalPdf(details.path);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function readUrl(url: string): Promise<string | null> {
	const out = await createWebTools(() => null).web_fetch!.execute!("verify-fetch", { url });
	const text = typeof out.details === "string" ? out.details : "";
	if (text === "" || text.startsWith("web_fetch failed")) return null;
	if (text.startsWith("web_fetch: this URL is a PDF")) return readRemotePdf(url);
	return text;
}

export function createSourceReader(deps: { allowedPdfPaths: () => string[] }): SourceTextReader {
	return {
		async read(ref) {
			if (/^https?:\/\//i.test(ref)) return readUrl(ref);
			if (deps.allowedPdfPaths().includes(ref)) return readLocalPdf(ref);
			return null;
		},
	};
}
