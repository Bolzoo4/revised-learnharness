import { personalLayer } from "@/src/server";

/** Start a review session: creates a `kind: "review"` chat. The client then sends its first message as in any chat. */
export async function POST() {
	return Response.json(personalLayer.startReviewSession());
}
