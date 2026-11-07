// src/agent/ext/video-runtime.ts
/**
 * Where the bundled Manim runtime lives (the contract in
 * docs/superpowers/plans/2026-11-07-manim-video.md, "The contract between A and B"):
 *   - packaged app: <process.resourcesPath>/manim-runtime
 *   - development and tests: LH_MANIM_RUNTIME overrides it
 * An absent directory (or one without bin/manim and bin/ffprobe) means the
 * runtime is absent: the video tool is not offered (REQ-vid-12).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function manimRuntimeRoot(
	env: Record<string, string | undefined> = process.env,
	resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
): string | null {
	const override = env.LH_MANIM_RUNTIME?.trim();
	const candidate = override ? override : resourcesPath ? path.join(resourcesPath, "manim-runtime") : null;
	if (!candidate) return null;
	const complete = fs.existsSync(path.join(candidate, "bin", "manim")) && fs.existsSync(path.join(candidate, "bin", "ffprobe"));
	return complete ? candidate : null;
}
