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

/** Default cap on a JSON request body. Study selections are at most 6000 characters, so 64 KiB is ample. */
export const DEFAULT_JSON_BODY_BYTES = 64 * 1024;
const TOO_LARGE = "the request body is too large";

/** Reads the body as text, failing as soon as more than `maxBytes` have arrived (no unbounded buffering). */
async function readCappedText(req: Request, maxBytes: number): Promise<string> {
	if (req.body === null) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new HttpError(413, TOO_LARGE);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * The request body as a JSON object; a malformed body, an array or null is a 400,
 * and a body over `maxBytes` (default 64 KiB) is a 413. The declared content-length
 * is checked before anything is read, and the streamed bytes are counted, so a
 * missing or false content-length cannot get past the cap.
 */
export async function readJsonObject(req: Request, maxBytes: number = DEFAULT_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) throw new HttpError(413, TOO_LARGE);
	const text = await readCappedText(req, maxBytes);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "the request body must be a JSON object");
	return body as Record<string, unknown>;
}
