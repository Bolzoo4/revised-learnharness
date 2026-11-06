import { FAILED_TEXT, HttpError, httpErrorResponse, lectureAudio, lectureService, readJsonObject } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET → the audio state of a lecture: keyConfigured, language, voice, ready/total, statuses per block, and the manifest (chunk timings of the ready blocks). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const lecture = lectureService.getLecture(id);
		if (!lecture) throw new HttpError(404, "unknown lecture");
		return Response.json(lectureAudio.summary(lecture));
	} catch (error) {
		return httpErrorResponse(error);
	}
}

/**
 * POST {} → 202: every missing block is generated in the background (the lecture's audio state is polled with GET).
 * POST {blockId} → 200 { block } once that block is ready (the on-demand path; a ready block costs nothing).
 * An unknown lecture is 404; a block not in this lecture is 404; no key is 503; a language without a voice is 422;
 * a block whose synthesis failed is 502 with the fixed text.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const lecture = lectureService.getLecture(id);
		if (!lecture) throw new HttpError(404, "unknown lecture");
		const body = await readJsonObject(req);
		if (body.blockId === undefined) {
			lectureAudio.requireSynthesis(lecture);
			lectureAudio.prefetch(lecture);
			return Response.json({ started: true }, { status: 202 });
		}
		if (typeof body.blockId !== "string") throw new HttpError(400, "blockId must be a string");
		const block = await lectureAudio.generateBlock(lecture, body.blockId);
		if (block.status !== "ready") throw new HttpError(502, block.error ?? FAILED_TEXT);
		return Response.json({ block });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
