import { agentGoals, agentResponse, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * PUT /api/ext/agent/goals/[id]/weights { chain?, <link type>?: 0..1 }: sets some weights of a goal
 * (REQ-graph-agent-17). Authentication is enforced by proxy.ts. → 200 { goal }.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const body = await readJsonObject(req);
		return agentResponse(await agentGoals.setWeights(id, body));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
