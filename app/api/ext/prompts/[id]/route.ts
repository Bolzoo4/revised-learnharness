import { httpErrorResponse, readJsonObject, resetExtPrompt, updateExtPrompt } from "@/src/server";

export const dynamic = "force-dynamic";

/** The write body is text and/or enabled; 256 KiB covers the largest text (20000 characters) with JSON escaping. */
const PROMPT_BODY_BYTES = 256 * 1024;

/** Save the version text and/or turn it on or off: body {text?: string, enabled?: boolean}. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const body = await readJsonObject(req, PROMPT_BODY_BYTES);
		return Response.json(updateExtPrompt(id, body));
	} catch (e) {
		return httpErrorResponse(e);
	}
}

/** Reset to the default: removes the version file and clears its switch. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		return Response.json(resetExtPrompt(id));
	} catch (e) {
		return httpErrorResponse(e);
	}
}
