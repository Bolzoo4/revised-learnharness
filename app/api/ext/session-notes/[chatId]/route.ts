// app/api/ext/session-notes/[chatId]/route.ts
import { httpErrorResponse, readJsonObject, setSessionNote } from "@/src/server";

export const dynamic = "force-dynamic";

/** PUT /api/ext/session-notes/[chatId]: the learner saves how they want to study this session's material; body { text } ("" clears it). */
export async function PUT(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
	const { chatId } = await params;
	try {
		const body = await readJsonObject(req);
		return Response.json({ note: setSessionNote(chatId, body.text) });
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/** DELETE /api/ext/session-notes/[chatId]: clears the note. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ chatId: string }> }) {
	const { chatId } = await params;
	try {
		setSessionNote(chatId, "");
		return Response.json({ note: null });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
