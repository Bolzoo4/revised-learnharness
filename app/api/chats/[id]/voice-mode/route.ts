import { getChat, stores } from "@/src/server";

/**
 * PUT {voiceMode: boolean} → the session's voice mode (REQ-chat-tts-08). Its own route, not the settings PUT:
 * the settings are replace-whole and would drop the flag. 404 unknown session; 400 when the body is not a
 * JSON object with a boolean voiceMode.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { voiceMode?: unknown } | null;
	if (typeof body !== "object" || body === null || typeof body.voiceMode !== "boolean") {
		return Response.json({ error: "voiceMode must be true or false" }, { status: 400 });
	}
	stores.chatStore.setVoiceMode(id, body.voiceMode);
	return Response.json({ voiceMode: body.voiceMode });
}
