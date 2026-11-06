import { httpErrorResponse, readJsonObject, requireString, StudyError, studyService } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST { action: "draft", documentId, page, selection? } → the model's { proposition, question, answer } (REQ-study-08).
 * POST { action: "confirm", documentId, page, proposition, question, answer, pin? } → { cardId, nodeId, nodeIds } (REQ-study-09, 10).
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const documentId = requireString(body, "documentId");
		if (body.action === "draft") return Response.json(await studyService.draftCard({ documentId, page: body.page, selection: body.selection }));
		if (body.action === "confirm") {
			return Response.json(
				await studyService.confirmCard({
					documentId,
					page: body.page,
					proposition: body.proposition,
					question: body.question,
					answer: body.answer,
					pin: body.pin,
				}),
			);
		}
		throw new StudyError(400, 'action must be "draft" or "confirm"');
	} catch (error) {
		return httpErrorResponse(error);
	}
}
