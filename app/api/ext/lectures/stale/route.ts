import { httpErrorResponse, lectureCleanup } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET → { chapters }: the chapters of an earlier attempt that still have something in the graph: failed,
 * interrupted or stopped, with no lecture. Each carries its nodes, links and the nodes other sources also
 * use (kept). Read only; removing them is POST /api/ext/lectures/[id]/purge.
 */
export async function GET() {
	try {
		return Response.json({ chapters: lectureCleanup.findStalePartialChapters() });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
