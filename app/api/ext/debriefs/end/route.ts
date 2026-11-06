import { debriefService, httpErrorResponse, outcomeResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST { sessionId } → ends the session and debriefs it. 201 { status: "created", entry }, 200 for an
 * existing debrief or an empty session, 202 when the commentary could not be produced now (the sweep retries).
 * The reply waits for the model.
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const { status, body: payload } = outcomeResponse(await debriefService.endSession(typeof body.sessionId === "string" ? body.sessionId : ""));
		return Response.json(payload, { status });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
