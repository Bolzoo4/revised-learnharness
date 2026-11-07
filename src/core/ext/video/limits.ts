// src/core/ext/video/limits.ts
/**
 * Video limits and the two pure checks the render path depends on (REQ-vid-04,
 * REQ-vid-05, REQ-vid-07). No I/O: the render service supplies the ffprobe
 * output and the file size.
 */

export const VIDEO_LIMITS = {
	/** Hard time limit for one render (REQ-vid-05). */
	renderTimeoutMs: 120_000,
	/** Fix attempts after the first render (REQ-vid-07): at most maxFixes + 1 renders. */
	maxFixes: 4,
	titleMaxChars: 120,
	briefMaxChars: 4_000,
	/** The scene source the model may write (bytes). */
	sceneMaxBytes: 64 * 1024,
	/** The finished mp4 (bytes). A 480p15 explainer is a few MB; this is generous. */
	outputMaxBytes: 25 * 1024 * 1024,
	/** The tail of a render's output handed back to the model (characters). */
	outputTailChars: 2_000,
} as const;

export type VideoInputCheck =
	| { ok: true; title: string; brief: string }
	| { ok: false; problems: string[] };

/** Title and brief: non-empty after trimming, bounded (REQ-vid-04). */
export function checkVideoInput(input: { title?: unknown; brief?: unknown }): VideoInputCheck {
	const problems: string[] = [];
	const title = typeof input.title === "string" ? input.title.trim() : "";
	const brief = typeof input.brief === "string" ? input.brief.trim() : "";
	if (title.length === 0) problems.push("title is required (a short name for the video card)");
	else if (title.length > VIDEO_LIMITS.titleMaxChars) problems.push(`title is over ${VIDEO_LIMITS.titleMaxChars} characters`);
	if (brief.length === 0) problems.push("brief is required (what the video must show)");
	else if (brief.length > VIDEO_LIMITS.briefMaxChars) problems.push(`brief is over ${VIDEO_LIMITS.briefMaxChars} characters`);
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, title, brief };
}

export type RenderProbeCheck = { ok: true; durationSec: number } | { ok: false; problem: string };

/**
 * The output check (REQ-vid-07): the file exists and is non-empty, is under
 * the size limit, its ffprobe report names an mp4/mov container with a video
 * stream and a positive, finite duration.
 */
export function checkRenderProbe(probe: unknown, sizeBytes: number): RenderProbeCheck {
	if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return { ok: false, problem: "the render wrote an empty file" };
	if (sizeBytes > VIDEO_LIMITS.outputMaxBytes) return { ok: false, problem: "the rendered video is over the size limit" };
	if (typeof probe !== "object" || probe === null) return { ok: false, problem: "the render output could not be read" };
	const p = probe as { format?: { format_name?: unknown; duration?: unknown }; streams?: unknown };
	const container = typeof p.format?.format_name === "string" ? p.format.format_name : "";
	if (!/\b(mp4|mov)\b/.test(container)) return { ok: false, problem: "the rendered file is not an mp4 video" };
	const streams = Array.isArray(p.streams) ? (p.streams as Array<{ codec_type?: unknown }>) : [];
	if (!streams.some((s) => s.codec_type === "video")) return { ok: false, problem: "the rendered file has no video stream" };
	const duration = typeof p.format?.duration === "string" ? Number(p.format.duration) : NaN;
	if (!Number.isFinite(duration) || duration <= 0) return { ok: false, problem: "the rendered video has no duration" };
	return { ok: true, durationSec: duration };
}
