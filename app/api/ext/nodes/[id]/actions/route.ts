// app/api/ext/nodes/[id]/actions/route.ts
import { NODE_ACTIONS, type NodeAction } from "@/src/core";
import { runNodeAction } from "@/src/server";
import { errorResponse } from "../../../error-response";

export const dynamic = "force-dynamic";

/** POST /api/ext/nodes/[id]/actions  {"action": NodeAction}. askInChat runs in the browser and is refused here. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
	const action = body?.action;
	if (typeof action !== "string" || !(NODE_ACTIONS as readonly string[]).includes(action)) {
		return Response.json({ error: "unknown action" }, { status: 400 });
	}
	try {
		return Response.json(await runNodeAction(id, action as NodeAction));
	} catch (error) {
		return errorResponse(error);
	}
}
