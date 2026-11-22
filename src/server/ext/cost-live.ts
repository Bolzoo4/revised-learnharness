// src/server/ext/cost-live.ts
/**
 * The shared daily ceiling (REQ-cost-01) and the step pricer for the study
 * stage's background model work. Same ceiling and env override as the
 * verification stage; the gate is built fresh per call so an environment
 * change lands without a restart. Also the separate ceiling of narration audio.
 */

import type { StepPricer } from "../../agent/ext/lecture/structured.ts";
import { agentSpendOnly, createCostGate, DEFAULT_AGENT_CEILING_USD, type CostGate } from "../../core/ext/cost-gate.ts";
import { callCost } from "../pricing.ts";
import { providerPauseView } from "./provider-pause.ts";
import { extStores } from "./stores.ts";

const DEFAULT_DAILY_CEILING_USD = 2;
function ceilingUsd(): number {
	const raw = Number(process.env.LH_EXT_DAILY_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING_USD;
}

/** Closed while the daily ceiling is spent OR a provider usage limit is in force (provider-pause.ts). */
export const liveCostGate: CostGate = {
	allowed: () => gate().allowed(),
	reason: () => gate().reason?.() ?? null,
	record: (usd, source) => gate().record(usd, source),
};

function gate(): CostGate {
	return createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd(), providerPause: providerPauseView });
}

const DEFAULT_AUDIO_CEILING_USD = 3;
function audioCeilingUsd(): number {
	const raw = Number(process.env.LH_EXT_AUDIO_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIO_CEILING_USD;
}

/**
 * The narration audio's own daily ceiling (LH_EXT_AUDIO_CEILING_USD, default 3 USD), on its own ledger
 * (audio-cost.jsonl). It does not share the model ceiling, and a model provider's usage pause does not
 * close it: Deepgram is not a model provider. Built fresh per call, like the model gate.
 */
export const liveAudioGate: CostGate = {
	allowed: () => audioGate().allowed(),
	reason: () => audioGate().reason?.() ?? null,
	record: (usd, source) => audioGate().record(usd, source),
};

function audioGate(): CostGate {
	return createCostGate({ store: extStores.audioCostStore, ceilingUsd: audioCeilingUsd() });
}

function agentCeilingUsd(): number {
	const raw = Number(process.env.LH_EXT_AGENT_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AGENT_CEILING_USD;
}

/**
 * The agent kind's own daily ceiling (LH_EXT_AGENT_CEILING_USD, default equal to the verification one), counting
 * only agent-triggered spend in the shared model ledger. A provider's usage pause also closes it.
 */
export const liveAgentGate: CostGate = {
	allowed: () => agentGate().allowed(),
	reason: () => agentGate().reason?.() ?? null,
	record: (usd, source) => agentGate().record(usd, source),
};

function agentGate(): CostGate {
	return createCostGate({ store: agentSpendOnly(extStores.costStore), ceilingUsd: agentCeilingUsd(), providerPause: providerPauseView });
}

/** USD of one billed step; an unpriced model counts as 0 (the same rule as the verification stage). */
export const livePriceStep: StepPricer = (model, usage) =>
	callCost({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }, model) ?? 0;
