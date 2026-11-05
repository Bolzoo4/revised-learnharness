import { lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
	const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
	return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
}

/** GET → { runs, lectures }: the per-chapter run status and the saved lectures (without their blocks). */
export async function GET() {
	try {
		const lectures = lectureService.listLectures().map((l) => ({ id: l.id, title: l.title, bookTitle: l.bookTitle, chapter: l.chapter, order: l.order }));
		return Response.json({ runs: lectureService.runStatuses(), lectures });
	} catch (error) {
		return errorResponse(error);
	}
}

/** POST { pdfPath, title? } → 202 { bookId }; the run continues in the background. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const { bookId, finished } = lectureService.startBookIngest({
			pdfPath: String(body.pdfPath ?? ""),
			...(typeof body.title === "string" ? { title: body.title } : {}),
		});
		void finished.catch((err) => console.error("[ext] lecture ingest failed:", err));
		return Response.json({ bookId }, { status: 202 });
	} catch (error) {
		return errorResponse(error);
	}
}
