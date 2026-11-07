// src/core/ext/exam-session/guard.ts
/**
 * The exam session's retrieval bounds and the material-before-web guard
 * (REQ-ex-05, REQ-ex-09), pure. An "exchange" is one agent build, that is one
 * learner turn: the agent is rebuilt per turn, so the state below starts empty
 * with each learner message and lives across the model steps of that turn.
 *
 * The guard is the code path, not a prompt promise: the search_web tool calls
 * webRefusal() before it dispatches anything.
 */

export const EXAM_LIMITS = {
	/** Passages per search (the default and the ceiling; a call cannot ask for more). */
	defaultK: 5,
	maxK: 5,
	/** Token cap of one search's passages (the default and the ceiling). */
	defaultMaxTokens: 1500,
	maxTokens: 1500,
	minTokens: 100,
	/** Longest search query. */
	maxQueryChars: 300,
	/** Longest solution text a check accepts. */
	maxSolutionChars: 4000,
	/** The reason a web search needs, bounds. */
	minReasonChars: 10,
	maxReasonChars: 300,
	/** Longest question put to the web. */
	maxWebQuestionChars: 500,
	/** Web searches per exchange (one learner turn). */
	webCallsPerExchange: 1,
} as const;

export interface ExchangeState {
	/** search_material calls made in this exchange. */
	searches: number;
	/** Accepted passages returned by those calls, in total. */
	acceptedHits: number;
	/** search_web calls dispatched in this exchange. */
	webCalls: number;
}

export function emptyExchange(): ExchangeState {
	return { searches: 0, acceptedHits: 0, webCalls: 0 };
}

export function afterSearch(state: ExchangeState, accepted: number): ExchangeState {
	return { ...state, searches: state.searches + 1, acceptedHits: state.acceptedHits + Math.max(0, accepted) };
}

export function afterWebCall(state: ExchangeState): ExchangeState {
	return { ...state, webCalls: state.webCalls + 1 };
}

/**
 * Why search_web may not run now, or null when it may. Allowed only after at least one
 * search_material call in this exchange that returned nothing accepted, and only up to
 * the per-exchange web limit. The texts are fixed; they name the next step for the model.
 */
export function webRefusal(state: ExchangeState): string | null {
	if (state.searches === 0) return "search the learner's material first (search_material); the web is searched only when the material has nothing";
	if (state.acceptedHits > 0) return "the material gave accepted passages in this exchange; answer from them and cite their labels";
	if (state.webCalls >= EXAM_LIMITS.webCallsPerExchange) return "the web search limit for this exchange is reached";
	return null;
}

/** Hits the agent may use: non-blank text and a positive score. Anything else is nothing accepted. */
export function acceptedHits<T extends { text: string; score: number }>(hits: readonly T[] | null | undefined): T[] {
	if (!Array.isArray(hits)) return [];
	return hits.filter((h) => typeof h.text === "string" && h.text.trim() !== "" && typeof h.score === "number" && Number.isFinite(h.score) && h.score > 0);
}

/** K for a search: the default when absent or not a number, otherwise floored and held to 1..maxK. */
export function clampK(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return EXAM_LIMITS.defaultK;
	return Math.min(EXAM_LIMITS.maxK, Math.max(1, Math.floor(value)));
}

/** The token cap for a search: the default when absent or not a number, otherwise held to minTokens..maxTokens. */
export function clampTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return EXAM_LIMITS.defaultMaxTokens;
	return Math.min(EXAM_LIMITS.maxTokens, Math.max(EXAM_LIMITS.minTokens, Math.floor(value)));
}
