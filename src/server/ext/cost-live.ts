// src/server/ext/cost-live.ts
/**
 * The shared daily ceiling (REQ-cost-01) and the step pricer for the study
 * stage's background model work. Same ceiling and env override as the
 * verification stage; the gate is built fresh per call so an environment
 * change lands without a restart.
 */

import type { StepPricer } from "../../agent/ext/lecture/structured.ts";
import { createCostGate, type CostGate } from "../../core/ext/cost-gate.ts";
import { callCost } from "../pricing.ts";
import { extStores } from "./stores.ts";

const DEFAULT_DAILY_CEILING_USD = 2;
function ceilingUsd(): number {
	const raw = Number(process.env.LH_EXT_DAILY_CEILING_USD);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CEILING_USD;
}

export const liveCostGate: CostGate = {
	allowed: () => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).allowed(),
	record: (usd, source) => createCostGate({ store: extStores.costStore, ceilingUsd: ceilingUsd() }).record(usd, source),
};

/** USD of one billed step; an unpriced model counts as 0 (the same rule as the verification stage). */
export const livePriceStep: StepPricer = (model, usage) =>
	callCost({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }, model) ?? 0;
