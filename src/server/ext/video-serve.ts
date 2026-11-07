// src/server/ext/video-serve.ts
/**
 * Serves one video job's mp4 (REQ-vid-10, REQ-vid-13). Only a finished
 * `video` job with its file on disk answers; anything else is a plain 404.
 * A Range header is honoured the same way as the lecture audio route, so the
 * native player can seek.
 */
import fs from "node:fs";
import type { JobRecord } from "../../core/contracts.ts";
import { jobVideoPath } from "../../store/ext/job-video.ts";
import { audioRange } from "./lecture-audio.ts";

function notFound(): Response {
	return Response.json({ error: "no video for this job" }, { status: 404 });
}

export function videoResponse(job: JobRecord | null, jobId: string, rangeHeader: string | null): Response {
	if (!job || job.id !== jobId || job.kind !== "video" || job.status !== "done") return notFound();
	let file: string;
	try {
		file = jobVideoPath(jobId);
	} catch {
		return notFound();
	}
	if (!fs.existsSync(file)) return notFound();
	const bytes = fs.readFileSync(file);
	const common = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
	const range = audioRange(rangeHeader, bytes.length);
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
}
