// src/agent/ext/practice/office-hours-agent.ts
/**
 * The office-hours session's agent: the practice agent's construction with its
 * own tools and instructions (the same seam the review agent uses).
 */

import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { officeHoursInstructions } from "./office-hours-instructions.ts";
import { officeHoursTools, type OfficeHoursToolContext } from "./office-hours-tools.ts";

export function createOfficeHoursAgent(ctx: OfficeHoursToolContext, opts: AgentBuildOptions = {}) {
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{ ...opts, tools: officeHoursTools(ctx), instructions: officeHoursInstructions(ctx.focus?.() ?? null) },
	);
}
