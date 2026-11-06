// src/server/ext/review-input.ts
/**
 * Request validation for the review routes (pure: no store is touched). Every
 * rejection is an HttpError with a fixed message, so no input is echoed back.
 */

import { HttpError } from "./http-error.ts";

/** Same cap as the review agent's measured duration (src/agent/ext/review-tools.ts MAX_REVIEW_SEC). */
export const MAX_CARD_REVIEW_SEC = 900;

export interface ReviewAnswerInput {
	nodeId: string;
	rating: number;
	/** Whole seconds, clamped to 1..MAX_CARD_REVIEW_SEC; 1 when the client sends none. */
	durationSec: number;
}

/** The body of POST /api/ext/review/answer: a card item's rating from the learner. */
export function parseReviewAnswer(body: Record<string, unknown>): ReviewAnswerInput {
	if (typeof body.nodeId !== "string" || body.nodeId === "") throw new HttpError(400, "nodeId must be a non-empty string");
	if (!Number.isInteger(body.rating) || (body.rating as number) < 1 || (body.rating as number) > 4) {
		throw new HttpError(400, "rating must be 1, 2, 3 or 4");
	}
	let durationSec = 1;
	if (body.durationSec !== undefined) {
		if (typeof body.durationSec !== "number" || !Number.isFinite(body.durationSec) || body.durationSec < 0) {
			throw new HttpError(400, "durationSec must be a number of seconds, 0 or more");
		}
		durationSec = Math.min(MAX_CARD_REVIEW_SEC, Math.max(1, Math.round(body.durationSec)));
	}
	return { nodeId: body.nodeId, rating: body.rating as number, durationSec };
}

/**
 * The optional body of POST /api/ext/review/session. A missing or non-object
 * body means a plain daily-review session; a `cardId` must be a non-empty string.
 */
export function parseSessionRequest(body: unknown): { cardId?: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
	const b = body as Record<string, unknown>;
	if (b.cardId === undefined) return {};
	if (typeof b.cardId !== "string" || b.cardId === "") throw new HttpError(400, "cardId must be a card id");
	return { cardId: b.cardId };
}
