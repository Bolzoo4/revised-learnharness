import { httpErrorResponse, listExtPrompts } from "@/src/server";

export const dynamic = "force-dynamic";

/** Every editable extension prompt: its default text, its saved version (or null) and whether that version is in use. */
export async function GET() {
	try {
		return Response.json(listExtPrompts());
	} catch (e) {
		return httpErrorResponse(e);
	}
}
