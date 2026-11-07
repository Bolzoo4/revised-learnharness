import { HttpError, httpErrorResponse, lectureService, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST { chapterIndex?: number } → 202 { bookId, chapters }: re-runs the chapters of the book that need it
 * (one chapter when chapterIndex is given, else every failed, interrupted, stopped_cost or stopped_provider
 * chapter), in the background, through the same pipeline and limits as the first run.
 * The path segment is the book id (bookId = "b" + 8 hex; the lecture routes beside it take a lecture id).
 * 400 for a bad index or an unknown chapter, 404 for an unknown book, 409 when the book is still being made,
 * a requested chapter is already running or does not need a retry, the PDF is no longer stored, or no chapter
 * needs one; 429 when the daily ceiling is spent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const body = await readJsonObject(req);
		let chapterIndex: number | undefined;
		if (body.chapterIndex !== undefined) {
			if (typeof body.chapterIndex !== "number" || !Number.isInteger(body.chapterIndex) || body.chapterIndex < 1) {
				throw new HttpError(400, "chapterIndex must be a whole number, 1 or more");
			}
			chapterIndex = body.chapterIndex;
		}
		const { chapters, finished } = lectureService.retryChapters(id, chapterIndex);
		void finished.catch((err) => console.error("[ext] lecture retry failed:", err));
		return Response.json({ bookId: id, chapters }, { status: 202 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
