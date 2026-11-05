// src/core/ext/review.ts
/**
 * review.jsonl events (spec REQ-pl-04, REQ-pl-15). One ledger, six event
 * types: real reviews, implicit reviews of premises, and the user's
 * manual marks. Pure: types, parser, constants.
 */

export type Channel = "fixed" | "dialogic" | "exercise";
export type ReviewRating = 1 | 2 | 3 | 4;

export type ReviewEvent =
	| {
			type: "review";
			nodeId: string;
			channel: Channel;
			rating: ReviewRating;
			durationSec: number;
			at: string;
			question?: string;
			answer?: string;
			weakPremises?: string[];
	  }
	| { type: "implicit"; nodeId: string; viaNodeId: string; outcome: "credit" | "penalty"; at: string }
	| { type: "pin"; nodeId: string; pinned: boolean; at: string }
	| { type: "retire"; nodeId: string; retired: boolean; at: string }
	| { type: "channel"; nodeId: string; channel: "fixed" | "dialogic" | null; at: string }
	| { type: "retention"; goalId: string; retention: number; at: string };

export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.97;

const CHANNELS = new Set<string>(["fixed", "dialogic", "exercise"]);

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

export function isValidRating(r: unknown): r is ReviewRating {
	return r === 1 || r === 2 || r === 3 || r === 4;
}

export function isValidRetention(r: unknown): r is number {
	return typeof r === "number" && Number.isFinite(r) && r >= MIN_RETENTION && r <= MAX_RETENTION;
}

export function parseReviewEvent(raw: unknown): ReviewEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	const at = r.at;
	switch (r.type) {
		case "review": {
			if (!str(r.nodeId) || typeof r.channel !== "string" || !CHANNELS.has(r.channel)) return null;
			if (!isValidRating(r.rating)) return null;
			if (typeof r.durationSec !== "number" || !Number.isFinite(r.durationSec) || r.durationSec < 0) return null;
			if (r.question !== undefined && typeof r.question !== "string") return null;
			if (r.answer !== undefined && typeof r.answer !== "string") return null;
			if (r.weakPremises !== undefined) {
				if (!Array.isArray(r.weakPremises) || !r.weakPremises.every(str)) return null;
				if (r.channel !== "dialogic") return null; // REQ-pl-15: only dialogic events carry weak premises
			}
			return {
				type: "review",
				nodeId: r.nodeId,
				channel: r.channel as Channel,
				rating: r.rating,
				durationSec: r.durationSec,
				at,
				...(r.question !== undefined ? { question: r.question as string } : {}),
				...(r.answer !== undefined ? { answer: r.answer as string } : {}),
				...(r.weakPremises !== undefined ? { weakPremises: [...(r.weakPremises as string[])] } : {}),
			};
		}
		case "implicit":
			if (!str(r.nodeId) || !str(r.viaNodeId)) return null;
			if (r.outcome !== "credit" && r.outcome !== "penalty") return null;
			return { type: "implicit", nodeId: r.nodeId, viaNodeId: r.viaNodeId, outcome: r.outcome, at };
		case "pin":
			if (!str(r.nodeId) || typeof r.pinned !== "boolean") return null;
			return { type: "pin", nodeId: r.nodeId, pinned: r.pinned, at };
		case "retire":
			if (!str(r.nodeId) || typeof r.retired !== "boolean") return null;
			return { type: "retire", nodeId: r.nodeId, retired: r.retired, at };
		case "channel":
			if (!str(r.nodeId)) return null;
			if (r.channel !== null && r.channel !== "fixed" && r.channel !== "dialogic") return null;
			return { type: "channel", nodeId: r.nodeId, channel: r.channel, at };
		case "retention":
			if (!str(r.goalId) || !isValidRetention(r.retention)) return null;
			return { type: "retention", goalId: r.goalId, retention: r.retention, at };
		default:
			return null;
	}
}
