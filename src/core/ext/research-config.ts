// src/core/ext/research-config.ts
/**
 * Defaults of the research loop (docs/superpowers/specs/2026-11-04-research-loop-design.md,
 * open items "default values"). Constants in code, overridable by environment
 * variables; there is no config file (nothing here needs more than a number).
 */

export type GapType = "uncovered" | "no-premises" | "weak-premise" | "unverified" | "contested-no-primary";

/** Expansion adds knowledge to the graph; verification only checks what is there (a `hold` mark allows only the latter). */
export type GapClass = "expansion" | "verification";

export const GAP_CLASS: Record<GapType, GapClass> = {
	uncovered: "expansion",
	"no-premises": "expansion",
	"weak-premise": "expansion",
	unverified: "verification",
	"contested-no-primary": "verification",
};

export interface ResearchConfig {
	/** Hours between scheduled cycles while the app is open. */
	cycleHours: number;
	/** Gap-type weights (REQ-rs-03). */
	weights: Record<GapType, number>;
	/** score = priority x weight x distanceBase^distance. */
	distanceBase: number;
	/** Score multiplier under an `expand` mark. */
	expandBoost: number;
	/** Depth limit (hops from the scope) when no mark carries one (REQ-rs-05). */
	defaultMaxDepth: number;
	/** The agent stops a gap when it reports confidence at or above this (REQ-rs-04). */
	confidenceThreshold: number;
	/** A gap that ingested sources but added fewer new nodes than this saturates its node (REQ-rs-06). */
	saturationMinNodes: number;
	/** Work bound per cycle that does not depend on prices (subscription models are unpriced, so the USD ceiling alone cannot bound them). */
	maxGapsPerCycle: number;
	/** Model-call bound for one gap's research loop. */
	maxTurnsPerGap: number;
}

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
	cycleHours: 6,
	weights: { "no-premises": 1, "contested-no-primary": 0.9, "weak-premise": 0.8, uncovered: 0.7, unverified: 0.6 },
	distanceBase: 0.5,
	expandBoost: 2,
	defaultMaxDepth: 2,
	confidenceThreshold: 0.8,
	saturationMinNodes: 2,
	maxGapsPerCycle: 5,
	maxTurnsPerGap: 20,
};

function positive(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** LH_EXT_CYCLE_HOURS and LH_EXT_CONFIDENCE_THRESHOLD (0 to 1). The daily ceiling is the shared cost gate's (LH_EXT_DAILY_CEILING_USD); anything invalid falls back to the default. */
export function researchConfigFromEnv(env: Record<string, string | undefined>): ResearchConfig {
	const threshold = positive(env.LH_EXT_CONFIDENCE_THRESHOLD, DEFAULT_RESEARCH_CONFIG.confidenceThreshold);
	return {
		...DEFAULT_RESEARCH_CONFIG,
		cycleHours: positive(env.LH_EXT_CYCLE_HOURS, DEFAULT_RESEARCH_CONFIG.cycleHours),
		confidenceThreshold: threshold <= 1 ? threshold : DEFAULT_RESEARCH_CONFIG.confidenceThreshold,
	};
}
