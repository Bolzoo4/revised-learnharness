import { embedAgentQueryLive, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/ext/agent/embed-query { text, kind?: "query" }: the app embeds one search query with its own model, the
 * one the index was built with (the read-only MCP server holds no model). Authentication is enforced by proxy.ts.
 * → 200 { vector, modelId, dim } | 400 { error } | 503 { unavailable } (no model in the cache, or the embedding failed).
 */
export async function POST(req: Request) {
	try {
		const body = await readJsonObject(req);
		const answer = await embedAgentQueryLive(body);
		return Response.json(answer.body, { status: answer.status });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
