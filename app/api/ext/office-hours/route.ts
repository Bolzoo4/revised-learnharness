import { httpErrorResponse, practiceService, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { label, sourceText? } starts a free session; POST { setId, exerciseId } starts a session that grades that exercise. → 201 { chatId, label }. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const view =
			typeof body.setId === "string" && typeof body.exerciseId === "string"
				? practiceService.startExercise({ setId: body.setId, exerciseId: body.exerciseId })
				: practiceService.startSession({ label: String(body.label ?? ""), ...(typeof body.sourceText === "string" ? { sourceText: body.sourceText } : {}) });
		return Response.json(view, { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
