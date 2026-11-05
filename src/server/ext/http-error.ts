// src/server/ext/http-error.ts
/**
 * The one error type for the ext API routes. Services throw an HttpError (or a
 * subclass) for an expected failure (400 bad input, 404 unknown, 409 conflict,
 * and the service-specific 422/429); routes turn any thrown value into a JSON
 * `{ error }` response with httpErrorResponse. Anything that is not an
 * HttpError is a bug: it is logged and answered as a generic 500, so neither
 * its message nor its stack reaches the client.
 */

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function httpErrorResponse(error: unknown): Response {
	if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
	console.error("[ext] unhandled route error:", error);
	return Response.json({ error: "internal error" }, { status: 500 });
}

/** The request body as a JSON object; a malformed body, an array or null is a 400. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
	const body: unknown = await req.json().catch(() => undefined);
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
	return body as Record<string, unknown>;
}
