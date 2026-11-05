// src/agent/ext/research-agent.ts
/**
 * The `research` session's agent: the review agent's construction (practice
 * agent, own tools, own instructions via AgentBuildOptions.instructions), plus
 * the shared daily ceiling (REQ-cost-01): the research console's model calls are
 * research spend. The gate is checked before each call (a closed gate refuses it)
 * and each admitted call's spend is recorded once, through the usage collector.
 * The engine is required: a fallback engine would bypass the gate.
 */

import type { CostGate } from "../../core/ext/cost-gate.ts";
import type { PiEngine } from "../models.ts";
import { createPracticeAgent, type AgentBuildOptions } from "../teacher-agent.ts";
import { RESEARCH_INSTRUCTIONS } from "./research-instructions.ts";
import { researchTools, type ResearchToolContext } from "./research-tools.ts";

const CEILING_MESSAGE = "the daily research ceiling is reached";

export interface ResearchAgentDeps {
	/** The shared daily gate (REQ-cost-01). */
	costGate: CostGate;
}

type UsageCollector = NonNullable<AgentBuildOptions["onUsage"]>;

const usd = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** A stream function that refuses the call when the gate is closed (or cannot answer, which counts as closed). */
export function gateResearchEngine(engine: PiEngine, gate: CostGate): PiEngine {
	const closed = (): boolean => {
		try {
			return !gate.allowed();
		} catch {
			return true;
		}
	};
	return {
		...engine,
		streamFn: ((model, context, options) => {
			if (closed()) throw new Error(CEILING_MESSAGE);
			return engine.streamFn(model, context, options);
		}) as PiEngine["streamFn"],
	};
}

/** The usage collector: records each admitted call's spend once on the shared gate, then passes the usage on to the chat's own collector. */
export function researchOnUsage(gate: CostGate, next?: UsageCollector): UsageCollector {
	return (usage) => {
		const amount = usd((usage as { cost?: { total?: unknown } } | undefined)?.cost?.total);
		if (amount > 0) {
			try {
				gate.record(amount, "research");
			} catch {
				/* a store that cannot record must not break the chat turn */
			}
		}
		next?.(usage);
	};
}

export function createResearchAgent(ctx: ResearchToolContext, opts: AgentBuildOptions, deps: ResearchAgentDeps) {
	if (!opts.engine) throw new Error("the research agent needs its engine: a fallback engine would bypass the daily ceiling");
	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{
			...opts,
			engine: gateResearchEngine(opts.engine, deps.costGate),
			onUsage: researchOnUsage(deps.costGate, opts.onUsage),
			tools: researchTools(ctx),
			instructions: RESEARCH_INSTRUCTIONS,
		},
	);
}
