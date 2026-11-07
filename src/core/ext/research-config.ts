// src/core/ext/research-config.ts
/**
 * Defaults of the research loop (docs/superpowers/specs/2026-11-04-research-loop-design.md,
 * open items "default values"). Constants in code, overridable by environment
 * variables; there is no config file (nothing here needs more than a number).
 */

/** `goal`: the one synthetic gap of a goal cycle (REQ-rs-19); it is never scored from the graph. */
export type GapType = "uncovered" | "no-premises" | "weak-premise" | "unverified" | "contested-no-primary" | "goal";

/** Expansion adds knowledge to the graph; verification only checks what is there (a `hold` mark allows only the latter). */
export type GapClass = "expansion" | "verification";

export const GAP_CLASS: Record<GapType, GapClass> = {
	uncovered: "expansion",
	"no-premises": "expansion",
	"weak-premise": "expansion",
	unverified: "verification",
	"contested-no-primary": "verification",
	goal: "expansion",
};

export interface ResearchConfig {
	/** Hours between scheduled cycles while the app is open. */
	cycleHours: number;
	/** Gap-type weights (REQ-rs-03). `goal` is required by the type but unused: a goal cycle's gap is not scored. */
	weights: Record<GapType, number>;
	/** score = priority x weight x distanceBase^distance. */
	distanceBase: number;
	/** Score multiplier under an `expand` mark. */
	expandBoost: number;
	/** Depth limit (hops from the scope) when no mark carries one (REQ-rs-05). */
	defaultMaxDepth: number;
	/** The agent stops a gap when it reports confidence at or above this, in (0, 1] (REQ-rs-04). */
	confidenceThreshold: number;
	/** A gap that ingested sources but added fewer new nodes than this saturates its node (REQ-rs-06). */
	saturationMinNodes: number;
	/** Work bound per cycle that does not depend on prices (subscription models are unpriced, so the USD ceiling alone cannot bound them). */
	maxGapsPerCycle: number;
	/** Model-call bound for one gap's research loop. */
	maxTurnsPerGap: number;
	/** Due watch entries run per cycle (oldest-checked first); the rest wait for the next cycle. */
	maxWatchEntriesPerCycle: number;
	/** Sources (and, separately, cited-but-unfetched locators) processed per gap; the rest of a finding is dropped. */
	maxSourcesPerGap: number;
}

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
	cycleHours: 6,
	weights: { "no-premises": 1, "contested-no-primary": 0.9, "weak-premise": 0.8, uncovered: 0.7, unverified: 0.6, goal: 1 },
	distanceBase: 0.5,
	expandBoost: 2,
	defaultMaxDepth: 2,
	confidenceThreshold: 0.8,
	saturationMinNodes: 2,
	maxGapsPerCycle: 5,
	maxTurnsPerGap: 20,
	maxWatchEntriesPerCycle: 5,
	maxSourcesPerGap: 20,
};

function atLeast(min: number, raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= min ? n : fallback;
}

/** LH_EXT_CYCLE_HOURS and LH_EXT_CONFIDENCE_THRESHOLD (in (0, 1]). The daily ceiling is the shared cost gate's (LH_EXT_DAILY_CEILING_USD); cycle hours below 0.1 and anything invalid fall back to the default. */
export function researchConfigFromEnv(env: Record<string, string | undefined>): ResearchConfig {
	const threshold = atLeast(Number.MIN_VALUE, env.LH_EXT_CONFIDENCE_THRESHOLD, DEFAULT_RESEARCH_CONFIG.confidenceThreshold);
	return {
		...DEFAULT_RESEARCH_CONFIG,
		cycleHours: atLeast(0.1, env.LH_EXT_CYCLE_HOURS, DEFAULT_RESEARCH_CONFIG.cycleHours),
		confidenceThreshold: threshold <= 1 ? threshold : DEFAULT_RESEARCH_CONFIG.confidenceThreshold,
	};
}
