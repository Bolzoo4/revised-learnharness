import fs from "node:fs";
import { HttpError, audioRange, httpErrorResponse, lectureAudio, lectureService } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET → the narration of one block as audio/mpeg. Only a block of this lecture, and only when its audio is
 * ready for the current voice; the file is addressed by the lecture's own block id, never by the input path.
 * A Range header is honoured (206 for one range, 416 when unsatisfiable).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; blockId: string }> }) {
	try {
		const { id, blockId } = await params;
		const lecture = lectureService.getLecture(id);
		if (!lecture) throw new HttpError(404, "unknown lecture");
		if (!lecture.blocks.some((b) => b.id === blockId)) throw new HttpError(404, "unknown block");
		const file = lectureAudio.blockFile(lecture, blockId);
		if (file === null) throw new HttpError(404, "no audio for this block");
		const bytes = fs.readFileSync(file.path);
		const common = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
		const range = audioRange(req.headers.get("range"), bytes.length);
		if (range.kind === "unsatisfiable") {
			return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${bytes.length}` } });
		}
		if (range.kind === "partial") {
			const part = bytes.subarray(range.start, range.end + 1);
			return new Response(new Uint8Array(part), {
				status: 206,
				headers: { ...common, "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`, "Content-Length": String(part.length) },
			});
		}
		return new Response(new Uint8Array(bytes), { status: 200, headers: { ...common, "Content-Length": String(bytes.length) } });
	} catch (error) {
		return httpErrorResponse(error);
	}
}
