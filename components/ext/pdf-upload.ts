// components/ext/pdf-upload.ts
/**
 * Browser side of the PDF chooser, shared by the study and lectures pages. The
 * checks here are a convenience: the server checks the bytes again. Nothing
 * from the chosen file except its bytes and the optional title is sent; the
 * upload goes out under the fixed name "upload.pdf".
 */

/** Same limit as the server (MAX_PDF_BYTES in src/server/ext/study-service.ts). */
export const MAX_PDF_UPLOAD_BYTES = 500 * 1024 * 1024;
export const PDF_TOO_LARGE_TEXT = "That PDF is too large (limit 500 MB).";
export const NOT_A_PDF_TEXT = "Choose a PDF file.";
export const EMPTY_FILE_TEXT = "That file is empty.";
export const ONE_FILE_TEXT = "Choose one PDF at a time.";
export const NO_FILE_TEXT = "No file was chosen.";

export interface PickedFile {
	name: string;
	size: number;
	type: string;
}

/** A fixed message for a file that cannot be sent, or null when it may be sent. */
export function checkPdfFile(file: PickedFile): string | null {
	const looksLikePdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
	if (!looksLikePdf) return NOT_A_PDF_TEXT;
	if (file.size === 0) return EMPTY_FILE_TEXT;
	if (file.size > MAX_PDF_UPLOAD_BYTES) return PDF_TOO_LARGE_TEXT;
	return null;
}

export type PdfPick = { ok: true; file: File } | { ok: false; error: string };

/** The one file from a file input or a drop, checked; anything other than exactly one PDF is refused. */
export function pickPdf(files: ArrayLike<File>): PdfPick {
	if (files.length === 0) return { ok: false, error: NO_FILE_TEXT };
	if (files.length > 1) return { ok: false, error: ONE_FILE_TEXT };
	const file = files[0]!;
	const error = checkPdfFile(file);
	return error === null ? { ok: true, file } : { ok: false, error };
}

/** The multipart body: the file under a fixed name, and the title only when one was typed. */
export function buildPdfUploadForm(file: Blob, title = ""): FormData {
	const form = new FormData();
	form.append("file", file, "upload.pdf");
	const trimmed = title.trim();
	if (trimmed !== "") form.append("title", trimmed);
	return form;
}

/** Posts the PDF to a route that takes multipart uploads. fetchFn is injected so the call is testable. */
export function uploadPdf(fetchFn: typeof fetch, url: string, file: Blob, title = ""): Promise<Response> {
	return fetchFn(url, { method: "POST", body: buildPdfUploadForm(file, title) });
}

/** The server's fixed `error` text when the response has one, otherwise the fallback. */
export async function failureText(res: Response, fallback: string): Promise<string> {
	const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
	return typeof json?.error === "string" && json.error !== "" ? json.error : fallback;
}
