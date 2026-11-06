import { exercisesOf } from "@/src/core";
import { httpErrorResponse, isPdfUpload, keepUploadedBook, lectureService, readJsonObject, stagePdfUpload } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET → { runs, lectures }: the per-chapter run status and the saved lectures (without their blocks).
 * Each lecture carries its bookId and its exercises: [{ blockId, prompt }] (the prompt bounded).
 */
export async function GET() {
	try {
		const lectures = lectureService.listLectures().map((l) => ({
			id: l.id,
			bookId: l.bookId,
			title: l.title,
			bookTitle: l.bookTitle,
			chapter: l.chapter,
			order: l.order,
			exercises: exercisesOf(l),
		}));
		return Response.json({ runs: lectureService.runStatuses(), lectures });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/**
 * POST { pdfPath, title? } → 202 { bookId }; the run continues in the background.
 * POST multipart/form-data (file, title?) → 202 { bookId }. The upload is copied into the documents
 * store first and the ingest reads that stable copy, so the bookId and the stored source locator
 * stay valid after the temp directory is released (released as soon as the copy is made).
 */
export async function POST(req: Request) {
	try {
		if (isPdfUpload(req)) {
			const staged = await stagePdfUpload(req);
			try {
				const pdfPath = await keepUploadedBook(staged.path);
				const started = lectureService.startBookIngest({ pdfPath, title: staged.title });
				void started.finished.catch((err) => console.error("[ext] lecture ingest failed:", err));
				return Response.json({ bookId: started.bookId }, { status: 202 });
			} finally {
				await staged.release();
			}
		}
		const body = await readJsonObject(req);
		const { bookId, finished } = lectureService.startBookIngest({
			pdfPath: String(body.pdfPath ?? ""),
			...(typeof body.title === "string" ? { title: body.title } : {}),
		});
		void finished.catch((err) => console.error("[ext] lecture ingest failed:", err));
		return Response.json({ bookId }, { status: 202 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
