import { httpErrorResponse, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { documentId, kind: "visit", page } or { documentId, kind: "close" } (REQ-study-03). → 204. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const documentId = requireString(body, "documentId");
		if (body.kind !== "visit" && body.kind !== "close") throw new StudyError(400, 'kind must be "visit" or "close"');
		studyService.recordReading({ documentId, kind: body.kind, page: body.page });
		return new Response(null, { status: 204 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
