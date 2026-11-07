// src/agent/ext/video-tools.ts
/**
 * The `video` job tool (REQ-vid-04, 11, 12). Modelled on the `demo` tool in
 * src/agent/tools/jobs.ts: server-executed, fire-and-forget, the job record is
 * created here (deduped by toolCallId) and the background runner is spawned.
 *
 * Where it is offered: THE single place is createTeacherTools (src/agent/tools.ts),
 * which spreads videoJobTools(...) next to the job tools. It is teach-phase only
 * for now: the prober's registry does not get it. It is offered only when the
 * Manim runtime exists (REQ-vid-12), and the settings toggle "video" removes it
 * like the other sub-agent tools (REQ-vid-11).
 */
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { JobRecord, VideoToolInput } from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";
import { checkVideoInput } from "../../core/ext/video/limits.ts";
import { manimRuntimeRoot } from "./video-runtime.ts";

export const videoInputSchema = Type.Object({
	title: Type.String({ description: "Short title for the video card, e.g. 'Why a union of sigma algebras can fail'." }),
	brief: Type.String({
		description:
			"Precise brief for the video maker: the concept, the steps in order, the formulas (exact), what appears on screen and when. " +
			"The maker sees NOTHING else of the lesson — include everything it needs.",
	}),
});

export type VideoInput = Static<typeof videoInputSchema>;

export interface VideoToolContext {
	chatId: string;
	jobStore: JobStore;
	/** Fire the background runner for a fresh job (fire-and-forget). */
	spawn: (job: JobRecord, input: VideoToolInput) => void;
}

const VIDEO_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The rendered video arrives as a new message when ready and is shown in the lesson; introduce it then.";

const VIDEO_DESCRIPTION =
	"Dispatch a background sub-agent that WRITES and RENDERS one short animated explanation (a Manim video, about 10 to 40 seconds) " +
	"and shows it in the lesson. Use it for a process that is better WATCHED than described: a construction, a transformation, " +
	"an argument whose steps appear one after another. For something the learner should OPERATE (sweep a parameter), use demo instead. " +
	"If the video fails, the result tells you to fall back to a demo. The call is ASYNC and fire-and-forget: it resolves immediately " +
	"and your turn continues; the video arrives later as a new message. Write a precise brief: the steps in order, the exact formulas, " +
	"what is on screen when.";

/**
 * The video tool, offered only when a runtime is present. `runtimeRoot`
 * defaults to the configured runtime (packaged resources or LH_MANIM_RUNTIME);
 * tests and the registry pass it explicitly.
 */
export function videoJobTools(ctx: VideoToolContext, runtimeRoot: string | null = manimRuntimeRoot()): Record<string, AgentTool<any>> {
	if (!runtimeRoot) return {};
	return {
		video: {
			name: "video",
			label: "video",
			description: VIDEO_DESCRIPTION,
			parameters: videoInputSchema,
			execute: serverExecute("video", videoInputSchema, (input, { toolCallId }) => {
				const checked = checkVideoInput(input);
				if (!checked.ok) return `ERROR: ${checked.problems.join("; ")}.`;
				const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
				const toolInput: VideoToolInput = { title: checked.title, brief: checked.brief };
				const job = existing ?? ctx.jobStore.createJob({ kind: "video", chatId: ctx.chatId, toolCallId, input: toolInput });
				if (!existing) ctx.spawn(job, toolInput);
				return `Dispatched (job ${job.id}). ${VIDEO_ACK}`;
			}),
		},
	};
}

