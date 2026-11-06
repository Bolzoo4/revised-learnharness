import { debriefService, httpErrorResponse, parseLectureActivity, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { type, sessionId, lectureId, slideId | nodeId | blockId } → { recorded }: the lecture player's trace. 409 once the session ended. */
export async function POST(req: Request) {
	try {
		return Response.json(debriefService.recordLectureActivity(parseLectureActivity(await readJsonObject(req))));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
