import { HttpError, httpErrorResponse, lectureCleanup, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST { chapterIndex } → 200 { nodesRemoved, chainsRemoved, nodesKept }: removes the leftovers of one
 * chapter of the book (the path segment is the book id) that failed, was interrupted or was stopped and has
 * no lecture. Nodes and links another source also refers to stay (nodesKept counts the nodes that stay).
 * 400 for a bad index or an unknown chapter, 404 for an unknown book, 409 with a fixed text when the book is
 * still being made, the chapter is running or has lectures or no leftovers, or an extraction is running.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const body = await readJsonObject(req);
		if (typeof body.chapterIndex !== "number" || !Number.isInteger(body.chapterIndex) || body.chapterIndex < 1) {
			throw new HttpError(400, "chapterIndex must be a whole number, 1 or more");
		}
		return Response.json(lectureCleanup.removeStalePartialChapter(id, body.chapterIndex));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
