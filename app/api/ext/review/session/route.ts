import { httpErrorResponse, HttpError, parseSessionRequest, personalLayer, ReviewInputError } from "@/src/server";

/**
 * Start a review session: creates a `kind: "review"` chat. With `{ cardId }` the
 * chat is a tutor session focused on that card ("Ask the tutor"). The client then
 * sends its first message as in any chat.
 */
export async function POST(req: Request) {
	try {
		const { cardId } = parseSessionRequest(await req.json().catch(() => null));
		return Response.json(personalLayer.startReviewSession(cardId));
	} catch (error) {
		if (error instanceof ReviewInputError) {
			return httpErrorResponse(error.kind === "unknown" ? new HttpError(404, error.message) : new HttpError(400, error.message));
		}
		return httpErrorResponse(error);
	}
}
