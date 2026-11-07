// src/agent/ext/visual-job-tools.ts
/**
 * The visual job tools for the extension sessions: `demo`, `visual`, and `video`
 * (when the Manim runtime exists). The teacher gets the same tools from
 * createTeacherTools (src/agent/tools.ts); the ext sessions (review, office
 * hours, lecture office hours, study, and the exam training next) get them
 * here. Same builders, same dispatch and runner, same user-toggle filter.
 *
 * NOT offered in the probe phase, and NOT added to upstream Practice. The
 * instruction paragraph (catalog id "visual-jobs", editable) is appended to
 * a session's prompt only when at least one of these tools is offered.
 *
 * Costs: a job's spend is folded into its JobRecord.usage (the runner's money
 * channel), not into the shared daily CostGate. The teacher's jobs do the same.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TeacherToolContext } from "../tools.ts";
import { filterEnabledTools, type EnabledTools } from "../../core/pending.ts";
import { healToolRecord } from "../tools/heal.ts";
import { jobTools } from "../tools/jobs.ts";
import { resolveExtPrompt } from "./prompt-override.ts";
import { videoJobTools } from "./video-tools.ts";

/** The job wiring an ext session needs: the three dependencies the teacher's job tools take. */
export type VisualJobDeps = Pick<TeacherToolContext, "chatId" | "jobStore" | "spawn">;

/** The model-facing names of the visual job tools (video is offered only with a runtime). */
export const VISUAL_JOB_NAMES = ["demo", "visual", "video"] as const;

/**
 * The tools for one ext session, filtered by the user's toggles.
 *
 * `enabled` is the resolved settings record (`agent.tools`, core/pending.ts
 * EnabledTools): a tool explicitly `false` is dropped. `runtimeRoot` is the
 * Manim runtime: omitted = the configured runtime (video offered only when it
 * exists), `null` = no video, a path = that runtime (tests).
 */
export function visualJobTools(
	deps: VisualJobDeps,
	enabled?: EnabledTools,
	runtimeRoot?: string | null,
): Record<string, AgentTool<any>> {
	const jobs = jobTools({ chatId: deps.chatId, jobStore: deps.jobStore, spawn: deps.spawn });
	const video = videoJobTools({ chatId: deps.chatId, jobStore: deps.jobStore, spawn: deps.spawn }, runtimeRoot);
	return healToolRecord(filterEnabledTools({ demo: jobs.demo!, visual: jobs.visual!, ...video }, enabled));
}

/** The default paragraph (editable as the "visual-jobs" catalog prompt). Its wording follows
 *  50-demos.md and 55-images.md and the video tool's own description. */
export const VISUAL_JOB_INSTRUCTIONS = `## Demos, figures and videos: show it, don't only describe it

Use these when the learner asks to see or visualize something, or when a verbal explanation has not worked. A moving process or an instrument the learner can operate often lands where another paragraph of prose does not. Each tool is fire-and-forget: it resolves at once with an acknowledgement, your turn continues, and the result arrives later as a new message that you teach from.

- \`video\` (only when it is among your tools): a short animated explanation of about 10 to 40 seconds, for a dynamic or mathematical process that is better watched than described: a construction, a transformation, an argument whose steps appear one after another. Write the brief with the steps in order, the exact formulas, and what is on screen and when.
- \`demo\`: an interactive single-file instrument the learner can operate: a parameter to sweep, a simulation, a sampling. Use it for something to operate, or for a process when \`video\` is not among your tools. Write the brief with the concept, every control and what it does, the interactions, and the formulas and constants.
- \`visual\`: one precise static figure for exact spatial pictures (coordinate geometry, number lines, vectors, function plots), where a wrong coordinate would assert something false. For flows and relations, write mermaid inline instead.

The builder sees nothing of the lesson: put everything it needs in the brief, and keep each brief self-contained. Never make a bare tool call with no text around it: say what is coming first. Keep teaching while it builds, and never wait, poll or invent its content. When it arrives, teach with it: point at its controls or parts by name, and do not repeat it. On failure, say so plainly and fall back to prose; if the brief was the problem, call again with a tighter one.`;

/** The paragraph for one session: the editable text (or its override), resolved on every call. */
export function visualJobInstructions(): string {
	return resolveExtPrompt("visual-jobs", VISUAL_JOB_INSTRUCTIONS);
}

/** The session's instructions with the paragraph appended, only when `tools` offers a visual job tool. */
export function withVisualJobInstructions(instructions: string, tools: Record<string, unknown>): string {
	if (!Object.keys(tools).some((name) => (VISUAL_JOB_NAMES as readonly string[]).includes(name))) return instructions;
	return `${instructions}\n\n${visualJobInstructions()}`;
}
