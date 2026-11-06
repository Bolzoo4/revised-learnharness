// src/core/ext/review-focus.ts
/**
 * What a tutor chat was opened about: a card ("Ask the tutor" on a card) or a
 * node with no card yet ("With the tutor" on the Review page). An append-only
 * ledger of `focus` events, one per chat; the last event for a chat wins.
 * Pure: parsing and lookup only.
 */

/** A focus on one card. Older events have this shape and stay valid. */
export interface CardFocusEvent {
	type: "focus";
	chatId: string;
	cardId: string;
	at: string;
}

/** A focus on one node (a node that has no card yet). */
export interface NodeFocusEvent {
	type: "focus";
	chatId: string;
	nodeId: string;
	at: string;
}

export type FocusEvent = CardFocusEvent | NodeFocusEvent;

/** What a chat is focused on, or null for an ordinary session. */
export type FocusTarget = { kind: "card"; cardId: string } | { kind: "node"; nodeId: string };

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

/** A focus event names exactly one of `cardId` and `nodeId`; anything else is invalid. */
export function parseFocusEvent(raw: unknown): FocusEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "focus" || !str(r.chatId) || !str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	const hasCard = r.cardId !== undefined;
	const hasNode = r.nodeId !== undefined;
	if (hasCard === hasNode) return null;
	if (hasCard) return str(r.cardId) ? { type: "focus", chatId: r.chatId, cardId: r.cardId, at: r.at } : null;
	return str(r.nodeId) ? { type: "focus", chatId: r.chatId, nodeId: r.nodeId, at: r.at } : null;
}

/** What a chat is focused on: the last focus event for it, or null for an ordinary (unfocused) session. */
export function focusTargetOf(events: readonly FocusEvent[], chatId: string): FocusTarget | null {
	let target: FocusTarget | null = null;
	for (const e of events) {
		if (e.chatId !== chatId) continue;
		target = "cardId" in e ? { kind: "card", cardId: e.cardId } : { kind: "node", nodeId: e.nodeId };
	}
	return target;
}

/** The card a chat is focused on, or null (also null when the chat is focused on a node). */
export function focusCardOf(events: readonly FocusEvent[], chatId: string): string | null {
	const target = focusTargetOf(events, chatId);
	return target?.kind === "card" ? target.cardId : null;
}
