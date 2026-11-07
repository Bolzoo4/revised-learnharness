import { ExamsError, examsService, httpErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** One collection with its exams and materials. → { collection, exams, materials }, or 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const detail = examsService.getCollection(id);
		if (detail === null) throw new ExamsError(404, "unknown collection");
		return Response.json(detail);
	} catch (error) {
		return httpErrorResponse(error);
	}
}
