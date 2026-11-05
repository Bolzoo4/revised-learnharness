// app/api/ext/error-response.ts
import { NodeKnowledgeError } from "@/src/server";

/** Expected failures carry their HTTP status; anything else is a real bug and is rethrown (500). */
export function errorResponse(error: unknown): Response {
	if (error instanceof NodeKnowledgeError) return Response.json({ error: error.message }, { status: error.status });
	throw error;
}
