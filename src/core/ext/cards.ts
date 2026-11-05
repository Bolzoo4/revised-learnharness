// src/core/ext/cards.ts
/**
 * cards.jsonl (REQ-pl-01 to REQ-pl-03): content variants of a node. A card
 * carries NO schedule; all variants of a node rotate under the node's one
 * FSRS state. Agent-authored cards are born `draft` and only a `status`
 * event (the user's approval) makes them schedulable.
 */

export type CardAuthor = "user" | "agent";
export type CardStatus = "draft" | "active" | "retired";

export type CardEvent =
	| {
			type: "created";
			cardId: string;
			nodeId: string;
			question: string;
			answer: string;
			author: CardAuthor;
			status: "draft" | "active";
			at: string;
	  }
	| { type: "status"; cardId: string; status: CardStatus; at: string };

export interface ContentCard {
	id: string;
	nodeId: string;
	question: string;
	answer: string;
	author: CardAuthor;
	status: CardStatus;
	createdAt: string;
}

const STATUSES = new Set<string>(["draft", "active", "retired"]);

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

export function parseCardEvent(raw: unknown): CardEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!str(r.cardId) || !str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	if (r.type === "status") {
		if (typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
		return { type: "status", cardId: r.cardId, status: r.status as CardStatus, at: r.at };
	}
	if (r.type === "created") {
		if (!str(r.nodeId) || !str(r.question) || !str(r.answer)) return null;
		if (r.author !== "user" && r.author !== "agent") return null;
		if (r.status !== "draft" && r.status !== "active") return null;
		if (r.author === "agent" && r.status !== "draft") return null; // REQ-pl-03
		return {
			type: "created",
			cardId: r.cardId,
			nodeId: r.nodeId,
			question: r.question,
			answer: r.answer,
			author: r.author,
			status: r.status,
			at: r.at,
		};
	}
	return null;
}

/** Replay in file order. A duplicate `created` and a `status` for an unknown card are ignored. */
export function deriveCards(events: readonly CardEvent[]): ContentCard[] {
	const cards = new Map<string, ContentCard>();
	for (const e of events) {
		if (e.type === "created") {
			if (cards.has(e.cardId)) continue;
			cards.set(e.cardId, {
				id: e.cardId,
				nodeId: e.nodeId,
				question: e.question,
				answer: e.answer,
				author: e.author,
				status: e.status,
				createdAt: e.at,
			});
		} else {
			const card = cards.get(e.cardId);
			if (card !== undefined) card.status = e.status;
		}
	}
	return [...cards.values()];
}

export function activeCardsOf(cards: readonly ContentCard[], nodeId: string): ContentCard[] {
	return cards.filter((c) => c.nodeId === nodeId && c.status === "active");
}

/** Variants rotate: the n-th fixed review of a node shows variant n mod count. Undefined when there is no active card. */
export function pickVariant(cards: readonly ContentCard[], nodeId: string, fixedReviews: number): ContentCard | undefined {
	const active = activeCardsOf(cards, nodeId);
	return active.length === 0 ? undefined : active[fixedReviews % active.length];
}
