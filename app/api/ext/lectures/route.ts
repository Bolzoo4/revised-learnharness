import { httpErrorResponse, lectureService, readJsonObject } from "@/src/server";

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

/** POST { pdfPath, title? } → 202 { bookId }; the run continues in the background. */
export async function POST(req: Request) {
	try {
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
