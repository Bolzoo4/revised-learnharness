// app/api/ext/research/session/route.ts
import { httpErrorResponse, startResearchSession } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST → { chatId }: starts a research console chat (kind "research"). The client then sends its first message as in any chat. */
export async function POST() {
	try {
		return Response.json(startResearchSession());
	} catch (error) {
		return httpErrorResponse(error);
	}
}
