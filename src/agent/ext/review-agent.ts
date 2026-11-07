// src/agent/ext/review-agent.ts
/**
 * The review session's agent (spec: session kind `review`). It rides the
 * practice agent's construction (a bare registry, the question-stop rule,
 * ordinary final prose) with its OWN tools and instructions, so upstream's
 * prompt-segment machinery is untouched; the only upstream edit is the
 * optional `instructions` field of AgentBuildOptions.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createPracticeAgent, type AgentBuildOptions } from "../teacher-agent.ts";
import { focusedNodeReviewInstructions, focusedReviewInstructions, reviewDailyInstructions } from "./review-instructions.ts";
import { reviewTools, type ReviewToolContext } from "./review-tools.ts";
import { visualJobTools, withVisualJobInstructions, type VisualJobDeps } from "./visual-job-tools.ts";

/** `jobs` is the teacher's job wiring (demo, visual, video); absent = no job tools (tests). */
export function createReviewAgent(ctx: ReviewToolContext, opts: AgentBuildOptions = {}, jobs?: VisualJobDeps) {
	const jobTools: Record<string, AgentTool<any>> = jobs ? visualJobTools(jobs, opts.toolToggles) : {};
	const instructions = ctx.nodeFocus
		? focusedNodeReviewInstructions(ctx.nodeFocus)
		: ctx.focus
			? focusedReviewInstructions(ctx.focus)
			: reviewDailyInstructions();
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{
			...opts,
			tools: { ...reviewTools(ctx), ...jobTools },
			instructions: withVisualJobInstructions(instructions, jobTools),
		},
	);
}
