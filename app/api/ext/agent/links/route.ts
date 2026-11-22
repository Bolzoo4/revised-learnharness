import { agentGoals, agentResponse, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/ext/agent/links { from, to, linkType }: a typed link between two existing nodes, origin agent
 * (REQ-graph-agent-10). Authentication is enforced by proxy.ts. → 200 { link }.
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return agentResponse(agentGoals.createLink({ from: body.from, to: body.to, linkType: body.linkType }));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
