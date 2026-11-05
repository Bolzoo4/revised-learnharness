// app/api/ext/nodes/[id]/explanation/route.ts
import { decideNodeProposal, httpErrorResponse, ensureNodeExplanation, saveNodeExplanation } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/ext/nodes/[id]/explanation
 *   {"action":"generate"}            write the missing or stale text now (single flight)
 *   {"action":"save","body":"..."}   the user's own version
 *   {"action":"approve"|"reject"}    decide the pending agent proposal
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { action?: unknown; body?: unknown } | null;
	if (body === null) return Response.json({ error: "expected a JSON body" }, { status: 400 });
	try {
		switch (body.action) {
			case "generate":
				return Response.json(await ensureNodeExplanation(id));
			case "save":
				if (typeof body.body !== "string") return Response.json({ error: "body must be a string" }, { status: 400 });
				return Response.json(saveNodeExplanation(id, body.body));
			case "approve":
				return Response.json(decideNodeProposal(id, "approved"));
			case "reject":
				return Response.json(decideNodeProposal(id, "rejected"));
			default:
				return Response.json({ error: "unknown action" }, { status: 400 });
		}
	} catch (error) {
		return httpErrorResponse(error);
	}
}
