// src/agent/ext/exams/exam-agent.ts
/**
 * The exam session's agent (session kind `exam`): the practice agent's construction
 * (a bare registry, ordinary final prose) with its own tools and its own prompt,
 * the same seam as the study, review and office-hours agents.
 *
 * Built once per learner turn, so the exchange guard (search_web) starts empty
 * with each learner message. The daily cost gate (REQ-ex-11) is checked before
 * every model call (a closed gate refuses the call before the provider) and each
 * admitted call's spend is recorded once, under the source "exam". The visual job
 * tools are gated the same way: no new job starts while the gate is closed.
 */

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../../../core/ext/provider-limit.ts";
import type { Exercise, SearchHit } from "../../../core/ext/exams/types.ts";
import type { LhMessage } from "../../../core/native-messages.ts";
import { acceptedHits, emptyExchange, EXAM_LIMITS } from "../../../core/ext/exam-session/guard.ts";
import type { PiEngine } from "../../models.ts";
import { createPracticeAgent, type AgentBuildOptions } from "../../teacher-agent.ts";
import { toToolResult } from "../../tool-execute.ts";
import { jobTools } from "../../tools/jobs.ts";
import { visualJobTools, withVisualJobInstructions, type VisualJobDeps } from "../visual-job-tools.ts";
import { examInstructions } from "./exam-instructions.ts";
import { examTools, PassageRegistry, type ExamToolContext } from "./exam-tools.ts";

/** What the agent needs of the bound session (the exam session service builds it). */
export interface ExamAgentContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
	collectionId: string;
	/** The bound exercise, or null when the session has none. */
	exercise: Exercise | null;
	/** Lexical search of the collection's material (the service's searchMaterial, through a port). */
	search(query: string, opts: { k: number; maxTokens: number }): SearchHit[];
}

export interface ExamAgentDeps {
	/** The shared daily gate (REQ-ex-11). */
	costGate: CostGate;
	/** The teacher's job wiring (demo, visual, video, research for search_web); absent = no jobs (tests). */
	jobs?: VisualJobDeps;
}

const CEILING_MESSAGE = "the daily cost limit is reached; the exam session cannot call a model now";
const JOB_REFUSAL = "The daily cost limit is reached; no new demo, figure or video starts now.";

type UsageCollector = NonNullable<AgentBuildOptions["onUsage"]>;
interface SpendLatch {
	refused: boolean;
}

const usd = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Why the gate refuses: a provider usage limit has its own text, the ceiling keeps its own. A gate that cannot answer counts as closed. */
function refusalText(gate: CostGate): string {
	try {
		return gate.reason?.() === "provider-limit" ? PROVIDER_LIMIT_MESSAGE : CEILING_MESSAGE;
	} catch {
		return CEILING_MESSAGE;
	}
}

/** A stream function that refuses the call when the latch is set or the gate is closed (or cannot answer). */
export function gateExamEngine(engine: PiEngine, gate: CostGate, latch: SpendLatch): PiEngine {
	const open = (): boolean => {
		if (latch.refused) return false;
		try {
			return gate.allowed();
		} catch {
			return false;
		}
	};
	return {
		...engine,
		streamFn: ((model, context, options) => {
			if (!open()) throw new Error(latch.refused ? CEILING_MESSAGE : refusalText(gate));
			return engine.streamFn(model, context, options);
		}) as PiEngine["streamFn"],
	};
}

/** The usage collector: each admitted call's spend is recorded once on the shared gate, then passed on to the chat's collector. */
export function examOnUsage(gate: CostGate, latch: SpendLatch, next?: UsageCollector): UsageCollector {
	return (usage) => {
		const amount = usd((usage as { cost?: { total?: unknown } } | undefined)?.cost?.total);
		if (amount > 0) {
			try {
				gate.record(amount, "exam");
			} catch {
				latch.refused = true;
			}
		}
		next?.(usage);
	};
}

/** The text of the newest learner message, or "" when there is none. */
export function latestLearnerText(messages: readonly LhMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		const c = m.content as unknown;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join("\n");
		return "";
	}
	return "";
}

/** Gated job tools: the visual job tools are the teacher's, and a closed gate stops a new job from starting. */
function gateJobTools(tools: Record<string, AgentTool<any>>, costOpen: () => boolean): Record<string, AgentTool<any>> {
	const out: Record<string, AgentTool<any>> = {};
	for (const [name, tool] of Object.entries(tools)) {
		const execute = tool.execute as unknown as (...args: unknown[]) => Promise<unknown>;
		out[name] = {
			...tool,
			execute: (async (id: string, input: unknown, signal?: AbortSignal) => (costOpen() ? execute(id, input, signal) : toToolResult(JOB_REFUSAL))) as AgentTool<any>["execute"],
		};
	}
	return out;
}

export function createExamAgent(ctx: ExamAgentContext, opts: AgentBuildOptions, deps: ExamAgentDeps) {
	if (!opts.engine) throw new Error("the exam agent needs its engine: a fallback engine would bypass the daily cost gate");
	const latch: SpendLatch = { refused: false };
	const costOpen = (): boolean => {
		if (latch.refused) return false;
		try {
			return deps.costGate.allowed();
		} catch {
			return false;
		}
	};

	// This turn's passages: the retrieval for the learner's latest question is in the prompt, and its labels are the ones the tools cite.
	const passages = new PassageRegistry();
	const question = latestLearnerText(ctx.chatStore.getChat(ctx.chatId)?.messages ?? []).trim();
	const queryText = (question !== "" ? question : ctx.exercise?.text ?? "").slice(0, EXAM_LIMITS.maxQueryChars);
	const passageLabels: string[] = [];
	if (ctx.exercise !== null && queryText !== "") {
		for (const hit of acceptedHits(ctx.search(queryText, { k: EXAM_LIMITS.defaultK, maxTokens: EXAM_LIMITS.defaultMaxTokens })).slice(0, EXAM_LIMITS.defaultK)) {
			passageLabels.push(passages.add(hit));
		}
	}

	const web = deps.jobs === undefined
		? undefined
		: async (input: { question: string; reason: string }): Promise<string> => {
				const research = jobTools({ chatId: deps.jobs!.chatId, jobStore: deps.jobs!.jobStore, spawn: deps.jobs!.spawn }).research!;
				const result = (await (research.execute as unknown as (...a: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)(
					`exam-web-${randomUUID()}`,
					{ question: input.question, context: input.reason },
					undefined,
				)) as { content: Array<{ text?: string }> };
				return result.content.map((c) => c.text ?? "").join("");
			};

	const exchange = { state: emptyExchange() };
	const toolContext: ExamToolContext = {
		collectionId: ctx.collectionId,
		exercise: ctx.exercise,
		search: ctx.search,
		webSearch: web,
		costOpen,
		passages,
		exchange,
	};
	const tools = examTools(toolContext);
	const jobs = deps.jobs === undefined ? {} : gateJobTools(visualJobTools(deps.jobs, opts.toolToggles), costOpen);
	const instructions = withVisualJobInstructions(examInstructions({ exercise: ctx.exercise, passages, passageLabels }), jobs);

	return createPracticeAgent(
		{ chatId: ctx.chatId, chatStore: ctx.chatStore },
		{
			...opts,
			engine: gateExamEngine(opts.engine, deps.costGate, latch),
			onUsage: examOnUsage(deps.costGate, latch, opts.onUsage),
			tools: { ...tools, ...jobs },
			instructions,
		},
	);
}
