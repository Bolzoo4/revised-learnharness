// src/agent/ext/study/study-agent.ts
/**
 * The study session's agent: the practice agent's construction (a bare tool
 * registry, ordinary final prose) with its own tools and a prompt composed per
 * turn. Same seam as the review and office-hours agents.
 */

import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { studyPrompt } from "./study-instructions.ts";
import { studyTools, type StudyToolContext } from "./study-tools.ts";

export function createStudyAgent(ctx: StudyToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: studyTools(ctx), instructions: studyPrompt(ctx) },
	);
}
