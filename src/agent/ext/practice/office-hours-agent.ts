// src/agent/ext/practice/office-hours-agent.ts
/**
 * The office-hours session's agent: the practice agent's construction with its
 * own tools and instructions (the same seam the review agent uses).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { visualJobTools, withVisualJobInstructions, type VisualJobDeps } from "../visual-job-tools.ts";
import { officeHoursInstructions } from "./office-hours-instructions.ts";
import { officeHoursTools, type OfficeHoursToolContext } from "./office-hours-tools.ts";

/** The study-preferences block goes after the instructions (and the exercise in focus), with its own paragraph. */
function withStudyNotes(instructions: string, studyNotes: string): string {
	return studyNotes === "" ? instructions : `${instructions}\n\n${studyNotes}`;
}

/** `jobs` is the teacher's job wiring (demo, visual, video); absent = no job tools (tests). */
export function createOfficeHoursAgent(ctx: OfficeHoursToolContext, opts: AgentBuildOptions = {}, jobs?: VisualJobDeps) {
	const jobTools: Record<string, AgentTool<any>> = jobs ? visualJobTools(jobs, opts.toolToggles) : {};
	const instructions = withStudyNotes(officeHoursInstructions(ctx.focus?.() ?? null), ctx.studyNotes?.() ?? "");
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{
			...opts,
			tools: { ...officeHoursTools(ctx), ...jobTools },
			instructions: withVisualJobInstructions(instructions, jobTools),
		},
	);
}
