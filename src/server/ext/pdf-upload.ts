// src/server/ext/pdf-upload.ts
/**
 * Multipart PDF upload for the study and lecture routes ("choose a PDF" on the
 * pages). The same routes accept the JSON path body as before; a request whose
 * Content-Type is multipart/form-data comes here instead.
 *
 * What is trusted from the client: one field named `file` (its bytes, checked
 * for the %PDF- header and the size limit) and an optional `title` text field.
 * The client's file name and any path are never read, stored or echoed: the
 * staged copy gets a generated name under a private temp directory inside the
 * extension data folder. The caller keeps a stable copy (keepStagedPdf) and then
 * calls release(), which deletes the temp directory whatever happened. Stale
 * temp directories of crashed requests are swept before each new staging.
 *
 * Body bounding follows app/api/graph/import/route.ts (readImportForm): the
 * bytes are counted as they arrive, so a missing or false Content-Length cannot
 * pass the cap. The whole body is buffered under that cap, as the import route
 * does; this is the one place the upload is held in memory.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import type { DocumentFiles } from "../../core/ext/study/ports.ts";
import { HttpError } from "./http-error.ts";
import { MAX_PDF_BYTES } from "./study-service.ts";

/** Room for the multipart envelope and the title field on top of the PDF itself. */
const MULTIPART_ALLOWANCE_BYTES = 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const MAX_TITLE_CHARS = 200;
export const DEFAULT_UPLOAD_TITLE = "Uploaded PDF";
/** A staged copy older than this is left behind by a crashed request and is removed before the next upload. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

const MSG = {
	tooLarge: "that PDF is too large (limit 500 MB)",
	bodyTooLarge: "the upload is too large (limit 500 MB)",
	notPdf: "that file is not a PDF",
	oneFile: "choose exactly one PDF file",
	unreadable: "the upload could not be read; choose the file again",
	titleType: "title must be text",
	titleLong: `title is too long (at most ${MAX_TITLE_CHARS} characters)`,
	stored: "the upload could not be stored; try again",
} as const;

export interface PdfUploadOptions {
	/** Directory the staged copy is created in (default: the extension temp area). */
	tempRoot?: string;
	/** Largest PDF accepted (default MAX_PDF_BYTES). */
	maxBytes?: number;
}

export interface StagedPdf {
	/** Absolute path of the private copy. Valid until release() is called. */
	readonly path: string;
	/** The title given by the client, or DEFAULT_UPLOAD_TITLE. */
	readonly title: string;
	/** Deletes the staged copy and its directory. Never rejects. */
	release(): Promise<void>;
}

/**
 * Removes the `upload-*` directories of the temp area that are older than maxAgeMs (by
 * modification time). Symbolic links and other entries are never followed or removed.
 * Failures are ignored: a sweep must never refuse an upload. Returns how many were removed.
 */
export async function sweepStaleUploads(tempRoot: string, nowMs: number, maxAgeMs: number = STALE_UPLOAD_MS): Promise<number> {
	let names: string[];
	try {
		names = await fs.readdir(tempRoot);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.startsWith("upload-")) continue;
		const dir = path.join(tempRoot, name);
		try {
			const info = await fs.lstat(dir);
			if (!info.isDirectory() || nowMs - info.mtimeMs <= maxAgeMs) continue;
			await fs.rm(dir, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Another request may be removing it, or it vanished: leave it.
		}
	}
	return removed;
}

/**
 * Copies a staged PDF into the content-addressed documents store (the same store the study
 * upload uses) and returns that stable path. The same bytes always yield the same path, so
 * the book's bookId is the same however often it is uploaded. The caller may release the
 * staged copy as soon as this resolves.
 */
export async function keepStagedPdf(stagedPath: string, files: Pick<DocumentFiles, "putPdf">): Promise<string> {
	const bytes = new Uint8Array(await fs.readFile(stagedPath));
	return files.putPdf(bytes).path;
}

/** The extension temp area: <data root>/ext/tmp, created on demand. */
export function uploadTempRoot(): string {
	return path.join(EXT_PATHS.dir, "tmp");
}

/** True when the request carries a multipart form (the upload path). */
export function isPdfUpload(request: Request): boolean {
	return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

/** Reads the whole body under the byte cap, then parses it as multipart form data. */
async function readUploadForm(request: Request, maxBytes: number): Promise<FormData> {
	const cap = maxBytes + MULTIPART_ALLOWANCE_BYTES;
	if (Number(request.headers.get("content-length")) > cap) {
		void request.body?.cancel().catch(() => undefined);
		throw new HttpError(413, MSG.bodyTooLarge);
	}
	const reader = request.body?.getReader();
	if (!reader) throw new HttpError(400, MSG.unreadable);
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > cap) throw new HttpError(413, MSG.bodyTooLarge);
			chunks.push(value);
		}
		const body = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, MSG.unreadable);
	} finally {
		// Do not wait for a tee's other consumer before refusing an upload.
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** The optional title: text, flattened, blank means the default; never the file name. */
function titleOf(value: FormDataEntryValue | null): string {
	if (value === null) return DEFAULT_UPLOAD_TITLE;
	if (typeof value !== "string") throw new HttpError(400, MSG.titleType);
	const flat = value.replace(/\s+/g, " ").trim();
	if (flat === "") return DEFAULT_UPLOAD_TITLE;
	if ([...flat].length > MAX_TITLE_CHARS) throw new HttpError(400, MSG.titleLong);
	return flat;
}

async function hasPdfHeader(file: Blob): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
	return head.length === PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * Validates the multipart upload and stages its PDF in a private temp directory.
 * Refusals are HttpErrors with fixed messages; nothing is left on disk when one is thrown.
 */
export async function stagePdfUpload(request: Request, options: PdfUploadOptions = {}): Promise<StagedPdf> {
	const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
	const form = await readUploadForm(request, maxBytes);
	const files = form.getAll("file");
	if (files.length !== 1 || !(files[0] instanceof File)) throw new HttpError(400, MSG.oneFile);
	const file = files[0];
	const title = titleOf(form.get("title"));
	if (file.size > maxBytes) throw new HttpError(413, MSG.tooLarge);
	if (!(await hasPdfHeader(file))) throw new HttpError(400, MSG.notPdf);

	const tempRoot = options.tempRoot ?? uploadTempRoot();
	await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
	await sweepStaleUploads(tempRoot, Date.now());
	const dir = await fs.mkdtemp(path.join(tempRoot, "upload-"));
	const release = () => fs.rm(dir, { recursive: true, force: true }).then(() => undefined, () => undefined);
	const filePath = path.join(dir, `${randomUUID()}.pdf`);
	try {
		await pipeline(
			Readable.fromWeb(file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
			createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
		);
	} catch {
		await release();
		throw new HttpError(500, MSG.stored);
	}
	return { path: filePath, title, release };
}
