import { practiceService } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST { label, sourceText? } starts a free session; POST { setId, exerciseId } starts a session that grades that exercise. → 201 { chatId, label }. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const view =
			typeof body.setId === "string" && typeof body.exerciseId === "string"
				? practiceService.startExercise({ setId: body.setId, exerciseId: body.exerciseId })
				: practiceService.startSession({ label: String(body.label ?? ""), ...(typeof body.sourceText === "string" ? { sourceText: body.sourceText } : {}) });
		return Response.json(view, { status: 201 });
	} catch (error) {
		const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
		return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
	}
}
