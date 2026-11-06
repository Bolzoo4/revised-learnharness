// src/agent/ext/lecture/structured.ts
/**
 * One schema-validated model submission (upstream's runSubmitAgent) with the
 * cost gate fed per billed step. The shared seam of every writer in this stage.
 */

import type { TSchema } from "typebox";
import type { ModelRole } from "../../../../config.ts";
import type { CostGate } from "../../../core/ext/cost-gate.ts";
import { PROVIDER_LIMIT_MESSAGE } from "../../../core/ext/provider-limit.ts";
import type { PiEngine } from "../../models.ts";
import { runSubmitAgent } from "../../subagents/submit-agent.ts";

/** Thrown when the daily ceiling is reached; callers stop the unit of work, they do not retry. */
export class CostCeilingError extends Error {
	constructor(reason: string) {
		super(`cost ceiling reached: ${reason}`);
		this.name = "CostCeilingError";
	}
}

/** Thrown when a provider usage limit (not the ceiling) closes the gate; callers stop and the work stays retryable. */
export class ProviderLimitedError extends Error {
	constructor() {
		super(PROVIDER_LIMIT_MESSAGE);
		this.name = "ProviderLimitedError";
	}
}

/** USD of one billed model step; injected by the server (upstream's pricing lives there). */
export type StepPricer = (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => number;

export function assertWithinCeiling(gate: CostGate): void {
	if (gate.allowed()) return;
	if (gate.reason?.() === "provider-limit") throw new ProviderLimitedError();
	throw new CostCeilingError("the daily ceiling for background model work is spent");
}

export async function runStructured<T>(opts: {
	engine: PiEngine;
	role: ModelRole;
	gate: CostGate;
	priceStep: StepPricer;
	/** Label recorded with each spend. */
	costSource: string;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	systemPrompt: string;
	prompt: string;
	signal?: AbortSignal;
	/** Semantic check at the submit seam; a string makes the model retry inside its turn budget. */
	validate?: (value: T) => string | null;
}): Promise<T> {
	assertWithinCeiling(opts.gate);
	return runSubmitAgent<T>({
		role: opts.role,
		toolName: opts.toolName,
		toolDescription: opts.toolDescription,
		parameters: opts.parameters,
		fill: (input) => input as T,
		systemPrompt: opts.systemPrompt,
		prompt: opts.prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) =>
			opts.gate.record(
				opts.priceStep(model, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }),
				opts.costSource,
			),
		neverSubmitted: `the model ended without calling ${opts.toolName}`,
		...(opts.validate ? { validate: opts.validate } : {}),
	});
}
