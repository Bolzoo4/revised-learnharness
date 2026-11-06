import { debriefService, httpErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST → runs one sweep now (ended sessions, the due week). Joins a sweep already running. */
export async function POST() {
	try {
		return Response.json(await debriefService.sweep());
	} catch (error) {
		return httpErrorResponse(error);
	}
}
