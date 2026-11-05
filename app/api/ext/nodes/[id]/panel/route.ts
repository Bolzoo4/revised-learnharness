// app/api/ext/nodes/[id]/panel/route.ts
import { httpErrorResponse, nodePanel } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/ext/nodes/[id]/panel: everything the node panel shows for one node. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(nodePanel(id));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
