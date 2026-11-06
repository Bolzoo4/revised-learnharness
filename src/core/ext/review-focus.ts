// src/core/ext/review-focus.ts
/**
 * Which card a tutor chat was opened about (the "Ask the tutor" button).
 * An append-only ledger of `focus` events, one per chat; the last event
 * for a chat wins. Pure: parsing and lookup only.
 */

export interface FocusEvent {
	type: "focus";
	chatId: string;
	cardId: string;
	at: string;
}

function str(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

export function parseFocusEvent(raw: unknown): FocusEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.type !== "focus" || !str(r.chatId) || !str(r.cardId) || !str(r.at) || Number.isNaN(Date.parse(r.at))) return null;
	return { type: "focus", chatId: r.chatId, cardId: r.cardId, at: r.at };
}

/** The card a chat is focused on, or null for an ordinary (unfocused) session. */
export function focusCardOf(events: readonly FocusEvent[], chatId: string): string | null {
	let cardId: string | null = null;
	for (const e of events) if (e.chatId === chatId) cardId = e.cardId;
	return cardId;
}
