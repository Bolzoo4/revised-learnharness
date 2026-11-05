// app/api/ext/verification/route.ts
import { trustViews, verifyNodesNow } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/ext/verification?nodeId=a&nodeId=b → { trust: TrustView[] } */
export async function GET(req: Request) {
	const ids = new URL(req.url).searchParams.getAll("nodeId").slice(0, 200);
	try {
		return Response.json({ trust: trustViews(ids) });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not read verification." }, { status: 500 });
	}
}

/** POST /api/ext/verification { nodeIds: string[] } → the run report (on-demand, any node). Runs to completion. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { nodeIds?: unknown };
	const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.filter((id): id is string => typeof id === "string" && id !== "").slice(0, 20) : [];
	if (nodeIds.length === 0) return Response.json({ error: "nodeIds must be a non-empty array of node ids (max 20)." }, { status: 400 });
	try {
		return Response.json(await verifyNodesNow(nodeIds));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Verification failed." }, { status: 500 });
	}
}
