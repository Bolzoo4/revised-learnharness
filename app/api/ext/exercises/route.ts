import { HttpError, httpErrorResponse, practiceService, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET ?goalId= → { sets }: exercise sets with their latest gradings (Maps flattened for JSON). */
export async function GET(req: Request) {
	try {
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
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** POST { goalId, count? } → 201 { setId }. Calls the model; the reply waits for it. */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		if (body.count !== undefined && (typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 1)) {
			throw new HttpError(400, "count must be a positive integer");
		}
		const res = await practiceService.createExerciseSet({
			goalId: String(body.goalId ?? ""),
			...(typeof body.count === "number" ? { count: body.count } : {}),
		});
		return Response.json(res, { status: 201 });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
