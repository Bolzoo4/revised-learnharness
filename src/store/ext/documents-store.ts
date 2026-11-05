// src/store/ext/documents-store.ts
/**
 * Documents store: stored PDF copies and page extractions (REQ-study-01, REQ-study-02).
 * Files are content-addressed by the document's sha256 id:
 *   data/ext/documents/<sha256>.pdf
 *   data/ext/documents/<sha256>.pages.json
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDocumentId, type DocumentFiles } from "../../core/ext/study/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createDocumentFiles(extDir: string): DocumentFiles {
	const docsDir = path.resolve(extDir, "documents");

	return {
		putPdf(bytes: Uint8Array): { id: string; path: string } {
			const id = createHash("sha256").update(bytes).digest("hex");
			assertExtFormat(extDir);
			const targetPath = path.join(docsDir, `${id}.pdf`);
			if (fs.existsSync(targetPath)) {
				return { id, path: targetPath };
			}
			ensureExtFormat(extDir);
			fs.mkdirSync(docsDir, { recursive: true });
			const tmp = `${targetPath}.tmp-${randomUUID()}`;
			try {
				fs.writeFileSync(tmp, bytes);
				fs.renameSync(tmp, targetPath);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					// ignore cleanup error
				}
				throw err;
			}
			return { id, path: targetPath };
		},

		pdfPath(id: string): string | null {
			if (!isDocumentId(id)) return null;
			assertExtFormat(extDir);
			const targetPath = path.join(docsDir, `${id}.pdf`);
			return fs.existsSync(targetPath) ? targetPath : null;
		},

		putPages(id: string, pages: readonly string[]): void {
			if (!isDocumentId(id)) {
				throw new Error(`document files: invalid document id ${id}`);
			}
			assertExtFormat(extDir);
			ensureExtFormat(extDir);
			fs.mkdirSync(docsDir, { recursive: true });
			const targetPath = path.join(docsDir, `${id}.pages.json`);
			writeFileAtomicSync(targetPath, JSON.stringify(pages, null, "\t") + "\n", { allowInPlaceFallback: true });
		},

		getPages(id: string): string[] | null {
			if (!isDocumentId(id)) return null;
			assertExtFormat(extDir);
			const targetPath = path.join(docsDir, `${id}.pages.json`);
			let raw: string;
			try {
				raw = fs.readFileSync(targetPath, "utf-8");
			} catch {
				return null;
			}
			try {
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) {
					return null;
				}
				return parsed;
			} catch {
				return null;
			}
		},
	};
}
