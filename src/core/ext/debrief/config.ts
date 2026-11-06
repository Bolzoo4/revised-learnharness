// src/core/ext/debrief/config.ts
/**
 * @node ext/debrief/config
 * Debrief settings read from the environment, each with a safe fallback: a
 * missing, non-numeric or out-of-range value never disables the feature or
 * makes every session look ended (REQ-deb-01, REQ-deb-02).
 */

export interface DebriefConfig {
	/** Minutes of inactivity after which a session counts as ended (default 30). */
	idleMs: number;
	/** Sessions whose last activity is older than this are never debriefed by the sweep (default 3 days). */
	lookbackMs: number;
	/** 0 (Sunday) to 6. */
	weeklyDay: number;
	/** 0 to 23, local time. */
	weeklyHour: number;
	/** Daily review budget the facts compare against, in seconds. */
	budgetSec: number;
}

export const DEFAULT_DEBRIEF_CONFIG: DebriefConfig = {
	idleMs: 30 * 60_000,
	lookbackMs: 3 * 24 * 3_600_000,
	weeklyDay: 0,
	weeklyHour: 18,
	budgetSec: 25 * 60,
};

function intIn(raw: string | undefined, min: number, max: number, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function readDebriefConfig(env: Record<string, string | undefined>, budgetSec: number = DEFAULT_DEBRIEF_CONFIG.budgetSec): DebriefConfig {
	const d = DEFAULT_DEBRIEF_CONFIG;
	return {
		idleMs: intIn(env.LH_EXT_DEBRIEF_IDLE_MIN, 1, 24 * 60, d.idleMs / 60_000) * 60_000,
		lookbackMs: intIn(env.LH_EXT_DEBRIEF_LOOKBACK_DAYS, 1, 60, d.lookbackMs / 86_400_000) * 86_400_000,
		weeklyDay: intIn(env.LH_EXT_WEEKLY_DAY, 0, 6, d.weeklyDay),
		weeklyHour: intIn(env.LH_EXT_WEEKLY_HOUR, 0, 23, d.weeklyHour),
		budgetSec: Number.isFinite(budgetSec) && budgetSec > 0 ? budgetSec : d.budgetSec,
	};
}
