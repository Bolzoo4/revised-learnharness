import { httpErrorResponse, lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → { nodes, edges }: lectures as special graph nodes with `cites` edges, derived from lecture.json (REQ-lec-11). */
export async function GET() {
	try {
		return Response.json(lectureService.overlay());
	} catch (error) {
		return httpErrorResponse(error);
	}
}
