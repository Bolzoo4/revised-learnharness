import { chatTts, httpErrorResponse, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST {sessionId, messageId} → audio/mpeg: the speech text of one assistant message of a session, read aloud
 * (the same synthesis, cache and audio budget as lecture narration). The body takes only those two fields;
 * a text field is a 400. Refusals: 404 unknown session or message, 422 not an assistant message, no speakable
 * text, or a language without a voice, 503 no key, 429 budget spent, 502 the service failed.
 */
export async function POST(req: Request): Promise<Response> {
	try {
		const audio = await chatTts.speak(await readJsonObject(req), req.signal);
		return new Response(new Uint8Array(audio), {
			status: 200,
			headers: { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length), "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		return httpErrorResponse(error);
	}
}
