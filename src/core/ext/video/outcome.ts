// src/core/ext/video/outcome.ts
/**
 * The render outcome vocabulary (REQ-vid-06, REQ-vid-08). Two audiences:
 *   - the model gets the render's own output tail, so it can fix the scene
 *     (renderFeedback);
 *   - the learner gets a fixed sentence and never any exception text
 *     (renderFailureNote).
 */
import { VIDEO_LIMITS } from "./limits.ts";

export type VideoRenderFailureReason = "timeout" | "aborted" | "denied" | "failed" | "no-output" | "bad-output" | "no-runtime";

export type VideoRenderOutcome =
	| { ok: true; durationSec: number }
	| { ok: false; reason: VideoRenderFailureReason; detail: string };

/** A sandbox refusal shows up as a permission error in the render's output. */
export function classifyRunFailure(output: string): "denied" | "failed" {
	return /Operation not permitted|Permission denied/i.test(output) ? "denied" : "failed";
}

/** The learner-facing failure sentence: fixed text per reason, no detail. */
export function renderFailureNote(reason: VideoRenderFailureReason): string {
	const why: Record<VideoRenderFailureReason, string> = {
		timeout: "the render ran too long",
		aborted: "the render was stopped",
		denied: "the scene tried to reach something it may not",
		failed: "the scene did not render",
		"no-output": "the render produced no file",
		"bad-output": "the rendered file was not a playable video",
		"no-runtime": "the video renderer is not installed",
	};
	return `The video could not be made: ${why[reason]}. Fall back to a demo or to prose.`;
}

/** The model-facing feedback for one render attempt (the fix loop). */
export function renderFeedback(outcome: VideoRenderOutcome): string {
	if (outcome.ok) return `PASSED: the video rendered (${outcome.durationSec.toFixed(1)} s). If you are satisfied, finish with your notes.`;
	const tail = outcome.detail.slice(-VIDEO_LIMITS.outputTailChars).trim();
	const lines = [`FAILED (${outcome.reason}).`];
	if (tail) lines.push(`Output tail:\n${tail}`);
	if (outcome.reason === "denied") {
		lines.push("The sandbox refused an operation: the scene may only write inside its folder and may not use the network or read other folders. Remove that behaviour.");
	}
	if (outcome.reason === "timeout") lines.push("The render exceeded its time limit: simplify the animation (fewer objects, shorter waits).");
	lines.push("Fix the scene (write_scene) and call render_video again.");
	return lines.join("\n");
}
