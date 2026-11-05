import { personalLayer } from "@/src/server";

export const dynamic = "force-dynamic";

/** Today's review plan (items, deferred, nodes needing a card) and per-goal readiness for the exercise set. */
export async function GET() {
	return Response.json(personalLayer.plan());
}
