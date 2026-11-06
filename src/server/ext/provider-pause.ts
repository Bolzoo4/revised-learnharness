// src/server/ext/provider-pause.ts
/**
 * The process-wide provider pause (provider limits, see core/ext/provider-limit.ts).
 *
 * One in-memory state per process, kept on globalThis so a dev reload keeps it.
 * It stores a pause end time, a count of consecutive limit hits and nothing
 * else: no raw provider text, nothing persisted (a restart retries once).
 *
 * Every background composition root builds its engine through `observedEngine`,
 * so a limit seen by any background call pauses every gated caller at once
 * (verification, research, debriefs, study, lectures, practice, explanations).
 */

import { withProviderLimitObserver } from "../../agent/ext/limit-aware-engine.ts";
import type { PiEngine } from "../../agent/models.ts";
import { isProviderLimitMessage, nextPauseMs, parseResetHint, PROVIDER_LIMIT_MESSAGE, type ProviderPause } from "../../core/ext/provider-limit.ts";

interface PauseState {
	/** Epoch ms the pause ends (exclusive): the gate reopens at exactly this instant. Null when none was ever set. */
	pausedUntil: number | null;
	/** Limit hits since the last successful model call. */
	hits: number;
}

const holder = globalThis as unknown as { __lhProviderPause?: PauseState };
const state: PauseState = (holder.__lhProviderPause ??= { pausedUntil: null, hits: 0 });

const inForce = (nowMs: number): boolean => state.pausedUntil !== null && nowMs < state.pausedUntil;

/**
 * Records a provider limit seen at `nowMs`. Ignored while a pause is already in force, so
 * several calls failing on the same limit count as one hit. Text that is not a limit is ignored.
 */
export function noteProviderLimit(message: unknown, nowMs: number): void {
	if (!isProviderLimitMessage(message)) return;
	if (inForce(nowMs)) return;
	state.hits += 1;
	const hint = parseResetHint(message, nowMs);
	state.pausedUntil = nowMs + nextPauseMs(state.hits, hint === null ? null : hint - nowMs);
}

/** A model call completed: the backoff starts again from the first hit. The pause in force is kept. */
export function noteProviderSuccess(): void {
	state.hits = 0;
}

/** The gate's view of the pause (true while a pause is in force at the given instant). */
export const providerPauseView: ProviderPause = { isPaused: (nowMs) => inForce(nowMs) };

export interface ProviderPauseStatus {
	paused: boolean;
	/** ISO time the pause ends, when paused. */
	pausedUntil: string | null;
	/** The fixed user-facing text, when paused. */
	message: string | null;
}

export function providerPauseStatus(nowMs: number): ProviderPauseStatus {
	if (!inForce(nowMs)) return { paused: false, pausedUntil: null, message: null };
	return { paused: true, pausedUntil: new Date(state.pausedUntil!).toISOString(), message: PROVIDER_LIMIT_MESSAGE };
}

/** Test seam: forgets every pause and hit. */
export function resetProviderPauseForTests(): void {
	state.pausedUntil = null;
	state.hits = 0;
}

/** A background engine whose call outcomes feed the process-wide pause. */
export function observedEngine(engine: PiEngine): PiEngine {
	return withProviderLimitObserver(engine, {
		onProviderLimit: (message) => noteProviderLimit(message, Date.now()),
		onProviderSuccess: () => noteProviderSuccess(),
	});
}
