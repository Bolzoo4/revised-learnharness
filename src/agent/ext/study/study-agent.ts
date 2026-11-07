// src/agent/ext/study/study-agent.ts
/**
 * The study session's agent: the practice agent's construction (a bare tool
 * registry, ordinary final prose) with its own tools and a prompt composed per
 * turn. Same seam as the review and office-hours agents.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { visualJobTools, withVisualJobInstructions, type VisualJobDeps } from "../visual-job-tools.ts";
import { studyPrompt } from "./study-instructions.ts";
import { studyTools, type StudyToolContext } from "./study-tools.ts";

/** `jobs` is the teacher's job wiring (demo, visual, video); absent = no job tools (tests). */
export function createStudyAgent(ctx: StudyToolContext, opts: AgentBuildOptions = {}, jobs?: VisualJobDeps) {
	const jobTools: Record<string, AgentTool<any>> = jobs ? visualJobTools(jobs, opts.toolToggles) : {};
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{
			...opts,
			tools: { ...studyTools(ctx), ...jobTools },
			instructions: withVisualJobInstructions(studyPrompt(ctx), jobTools),
		},
	);
}
