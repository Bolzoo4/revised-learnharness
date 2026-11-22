import { agentGoals, agentResponse, httpErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/ext/agent/sandbox: the agent sandbox folder's absolute path and its files (REQ-graph-agent-22). The
 * folder is created on demand. Authentication is enforced by proxy.ts. → 200 { path, files: { items, count, truncated } }.
 */
export async function GET() {
	try {
		return agentResponse(await agentGoals.sandbox());
	} catch (error) {
		return httpErrorResponse(error);
	}
}
