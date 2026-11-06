import { httpErrorResponse, HttpError, parseSessionRequest, personalLayer, ReviewInputError } from "@/src/server";

/**
 * Start a review session: creates a `kind: "review"` chat. With `{ cardId }` the
 * chat is a tutor session focused on that card ("Ask the tutor"); with `{ nodeId }`
 * it is one focused on a node that has no card yet ("With the tutor"). The client
 * then sends its first message as in any chat.
 */
export async function POST(req: Request) {
	try {
		const { cardId, nodeId } = parseSessionRequest(await req.json().catch(() => null));
		const chat = nodeId !== undefined ? personalLayer.startNodeSession(nodeId) : personalLayer.startReviewSession(cardId);
		return Response.json(chat);
	} catch (error) {
		if (error instanceof ReviewInputError) {
			return httpErrorResponse(error.kind === "unknown" ? new HttpError(404, error.message) : new HttpError(400, error.message));
		}
		return httpErrorResponse(error);
	}
}
