import { practiceService } from "@/src/server";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
	const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
	return Response.json({ error: error instanceof Error ? error.message : "Request failed." }, { status });
}

/** GET ?goalId= → { sets }: exercise sets with their latest gradings (Maps flattened for JSON). */
export async function GET(req: Request) {
	const goalId = new URL(req.url).searchParams.get("goalId") ?? undefined;
	const sets = practiceService.listSets(goalId).map((s) => ({
		setId: s.setId,
		goalId: s.goalId,
		createdAt: s.createdAt,
		applied: s.applied,
		exercises: s.exercises.map((e) => {
			const g = s.graded.get(e.id);
			return { id: e.id, prompt: e.prompt, graded: g ? { outcome: g.outcome, lowConfidence: g.lowConfidence } : null };
		}),
	}));
	return Response.json({ sets });
}

/** POST { goalId, count? } → 201 { setId }. Calls the model; the reply waits for it. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const res = await practiceService.createExerciseSet({
			goalId: String(body.goalId ?? ""),
			...(typeof body.count === "number" ? { count: body.count } : {}),
		});
		return Response.json(res, { status: 201 });
	} catch (error) {
		return errorResponse(error);
	}
}
