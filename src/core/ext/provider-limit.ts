// src/core/ext/provider-limit.ts
/**
 * Provider usage limits for background model work (subscription plans, rate
 * limits, overloaded providers). Pure: no clock, no state. The server layer
 * owns the pause itself (src/server/ext/provider-pause.ts) and feeds these
 * functions the message text and the current time.
 *
 * Only fixed labels leave this layer: the raw provider text is read here and
 * never stored, logged or returned.
 */

/** The one fixed text shown to a user when background work is refused by a provider limit. */
export const PROVIDER_LIMIT_MESSAGE = "The AI provider's usage limit is reached; try again later.";

/** A pause is never shorter than this, nor longer than a day, whatever the provider said. */
export const MIN_PAUSE_MS = 60_000;
export const MAX_PAUSE_MS = 24 * 60 * 60_000;
/** The first pause after a limit hit; each further consecutive hit doubles it up to the cap. */
export const BASE_PAUSE_MS = 30 * 60_000;
export const CAP_PAUSE_MS = 6 * 60 * 60_000;

/** A view of the pause that the cost gate consults: true while background work must not call a model. */
export interface ProviderPause {
	isPaused(nowMs: number): boolean;
}

/** Phrases that name a provider usage, rate or capacity limit. Matched case-insensitively. */
const LIMIT_PATTERNS: readonly RegExp[] = [
	/usage limit (reached|exceeded)/i,
	/rate[\s_-]?limit/i,
	/subscription_sharing_usage_limit_exceeded/i,
	/too many requests/i,
	/\b429\b/,
	/\bquota\b/i,
	/\boverloaded\b/i,
	/\b(over|at) capacity\b/i,
	/capacity (exceeded|reached|limit)/i,
];

/** "limit reached" is a limit only when the text does not name a token, context or output size. */
const LIMIT_REACHED = /limit (reached|exceeded)/i;
const SIZE_WORDS = /\b(token|tokens|context|prompt|output|length|window|input)\b/i;

/** True when the text is a provider usage, rate or capacity limit. Size and request errors are not. */
export function isProviderLimitMessage(text: unknown): boolean {
	if (typeof text !== "string" || text.trim() === "") return false;
	if (LIMIT_PATTERNS.some((p) => p.test(text))) return true;
	return LIMIT_REACHED.test(text) && !SIZE_WORDS.test(text);
}

const UNIT_MS: Record<string, number> = { second: 1_000, seconds: 1_000, minute: 60_000, minutes: 60_000, hour: 3_600_000, hours: 3_600_000 };

/**
 * A reset time the provider named, as an epoch ms, or null when the text
 * names none clearly. Understood forms: `retry-after: N` (seconds),
 * `try again in N minutes|hours|seconds`, and `resets H:MM am|pm` (the next
 * such local time after `nowMs`).
 */
export function parseResetHint(text: unknown, nowMs: number): number | null {
	if (typeof text !== "string" || !Number.isFinite(nowMs)) return null;
	const retryAfter = /retry[\s_-]?after\W{0,3}(\d{1,6})\b/i.exec(text);
	if (retryAfter) return nowMs + Number(retryAfter[1]) * 1_000;
	const inUnit = /try again in (\d{1,4}) (seconds?|minutes?|hours?)\b/i.exec(text);
	if (inUnit) return nowMs + Number(inUnit[1]) * UNIT_MS[inUnit[2]!.toLowerCase()]!;
	const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
	if (clock) {
		let hour = Number(clock[1]);
		const minute = clock[2] === undefined ? 0 : Number(clock[2]);
		if (hour < 1 || hour > 12 || minute > 59) return null;
		const meridiem = clock[3]!.toLowerCase();
		if (meridiem === "am") hour = hour === 12 ? 0 : hour;
		else hour = hour === 12 ? 12 : hour + 12;
		const next = new Date(nowMs);
		next.setHours(hour, minute, 0, 0);
		if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
		return next.getTime();
	}
	return null;
}

/**
 * The pause length after a limit hit. `consecutiveHits` counts limit hits since the
 * last successful model call (1 = first). A reset hint in the provider's own words
 * replaces the backoff: `hintDeltaMs` is the time until that reset, clamped to
 * [1 min, 24 h].
 */
export function nextPauseMs(consecutiveHits: number, hintDeltaMs?: number | null): number {
	if (typeof hintDeltaMs === "number" && Number.isFinite(hintDeltaMs)) {
		return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, hintDeltaMs));
	}
	const hits = Number.isFinite(consecutiveHits) && consecutiveHits >= 1 ? Math.floor(consecutiveHits) : 1;
	// 30 min, 1 h, 2 h, 4 h, then the 6 h cap. Beyond 2^6 the cap holds without overflow.
	const doubled = BASE_PAUSE_MS * 2 ** Math.min(hits - 1, 16);
	return Math.min(CAP_PAUSE_MS, doubled);
}
