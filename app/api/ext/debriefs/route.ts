import { debriefService, httpErrorResponse, parseListQuery } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?limit=&kind=&since= → { entries, count, truncated, open }: the history (newest first) and the sessions still running. */
export async function GET(req: Request) {
	try {
		const list = debriefService.list(parseListQuery(new URL(req.url).searchParams));
		return Response.json({ ...list, open: debriefService.openSessions() });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
