import { debriefService, httpErrorResponse, parseListQuery, providerPauseStatus } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?limit=&kind=&since= → { entries, count, truncated, open, providerPausedUntil? }: the history (newest first), the sessions still running, and the provider pause in force (ISO end, present only while paused). */
export async function GET(req: Request) {
	try {
		const list = debriefService.list(parseListQuery(new URL(req.url).searchParams));
		const paused = providerPauseStatus(Date.now()).pausedUntil;
		return Response.json({ ...list, open: debriefService.openSessions(), ...(paused !== null ? { providerPausedUntil: paused } : {}) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
