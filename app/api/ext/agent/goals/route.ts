import { agentGoals, agentResponse, httpErrorResponse, readJsonObject, type AgentGoalInput } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/ext/agent/goals { title, targets?, files?: [{ name }], weights?, priority? }: the study agent creates a goal
 * (REQ-graph-agent-08). Each file is the name of a file in the agent sandbox folder (REQ-graph-agent-23). Authentication is enforced by proxy.ts for every /api route. → 200 { goalId, nodeIds }.
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		return agentResponse(await agentGoals.create(body as unknown as AgentGoalInput));
	} catch (error) {
		return httpErrorResponse(error);
	}
}
