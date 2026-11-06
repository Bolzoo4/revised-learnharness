import { httpErrorResponse, isPdfUpload, lectureService, readJsonObject, stagePdfUpload } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → { runs, lectures }: the per-chapter run status and the saved lectures (without their blocks). */
export async function GET() {
	try {
		const lectures = lectureService.listLectures().map((l) => ({ id: l.id, title: l.title, bookTitle: l.bookTitle, chapter: l.chapter, order: l.order }));
		return Response.json({ runs: lectureService.runStatuses(), lectures });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/**
 * POST { pdfPath, title? } → 202 { bookId }; the run continues in the background.
 * POST multipart/form-data (file, title?) → 202 { bookId }. The ingest reads the PDF while it runs,
 * so the staged copy is deleted when the run settles, not when this response is sent.
 */
export async function POST(req: Request) {
	try {
		if (isPdfUpload(req)) {
			const staged = await stagePdfUpload(req);
			let started: ReturnType<typeof lectureService.startBookIngest>;
			try {
				started = lectureService.startBookIngest({ pdfPath: staged.path, title: staged.title });
			} catch (error) {
				await staged.release();
				throw error;
			}
			void started.finished.catch((err) => console.error("[ext] lecture ingest failed:", err)).finally(() => staged.release());
			return Response.json({ bookId: started.bookId }, { status: 202 });
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
