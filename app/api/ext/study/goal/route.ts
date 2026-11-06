import { httpErrorResponse, readJsonObject, requireString, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { documentId, title, statement }: starts a goal from a document (umbrella REQ-goal-01). → { goalId }. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return Response.json(studyService.startGoal({ documentId: requireString(body, "documentId"), title: body.title, statement: body.statement }), { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
