import {
	HttpError,
	httpErrorResponse,
	parseReviewAnswer,
	personalLayer,
	readJsonObject,
	ReviewInputError,
} from "@/src/server";

/** Records the learner's rating of a card item of today's plan (the review runner, no agent). */
export async function POST(req: Request) {
	try {
		const res = personalLayer.answerCard(parseReviewAnswer(await readJsonObject(req)));
		return Response.json({ ok: true, dueAt: res.dueAt });
	} catch (error) {
		if (error instanceof ReviewInputError) {
			return httpErrorResponse(error.kind === "unknown" ? new HttpError(404, "unknown node") : new HttpError(400, error.message));
		}
		return httpErrorResponse(error);
	}
}
