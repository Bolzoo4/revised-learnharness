// src/agent/ext/review-agent.ts
/**
 * The review session's agent (spec: session kind `review`). It rides the
 * practice agent's construction (a bare registry, the question-stop rule,
 * ordinary final prose) with its OWN tools and instructions, so upstream's
 * prompt-segment machinery is untouched; the only upstream edit is the
 * optional `instructions` field of AgentBuildOptions.
 */

import { createPracticeAgent, type AgentBuildOptions } from "../teacher-agent.ts";
import { REVIEW_INSTRUCTIONS } from "./review-instructions.ts";
import { reviewTools, type ReviewToolContext } from "./review-tools.ts";

export function createReviewAgent(ctx: ReviewToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: reviewTools(ctx), instructions: REVIEW_INSTRUCTIONS },
	);
}
