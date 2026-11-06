// components/ext/review-logic.ts
/**
 * Pure logic of the Review page: what the card runner shows, the request
 * bodies it sends, and how the card list is grouped. No React, no fetch.
 */

import { REQUEST_FAILED } from "./study-logic";

export type Rating = 1 | 2 | 3 | 4;
export const RATINGS: ReadonlyArray<{ rating: Rating; label: string }> = [
	{ rating: 1, label: "Again" },
	{ rating: 2, label: "Hard" },
	{ rating: 3, label: "Good" },
	{ rating: 4, label: "Easy" },
];

export interface PlanItemView {
	nodeId: string;
	name: string;
	channel: "fixed" | "dialogic";
	card?: { cardId: string; question: string; answer: string };
}

/** The part of GET /api/ext/review/plan the page reads. */
export interface PlanView {
	items: PlanItemView[];
	deferred: Array<{ nodeId: string; name: string }>;
	needsCard: Array<{ nodeId: string; name: string }>;
	due: number;
	plannedSec: number;
}

export interface RunnerCard {
	nodeId: string;
	name: string;
	cardId: string;
	question: string;
	answer: string;
}

/** The card items of today's plan, in review order: the fixed items that carry a card. */
export function runnerCards(plan: PlanView): RunnerCard[] {
	return plan.items.flatMap((i) =>
		i.channel === "fixed" && i.card !== undefined
			? [{ nodeId: i.nodeId, name: i.name, cardId: i.card.cardId, question: i.card.question, answer: i.card.answer }]
			: [],
	);
}

/** Items that need a conversation (dialogic channel): not part of the card runner. */
export function conversationCount(plan: PlanView): number {
	return plan.items.length - runnerCards(plan).length;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

/** One line above the runner: due count, planned items and minutes, deferred count. */
export function summaryLine(plan: PlanView): string {
	const minutes = plan.plannedSec > 0 ? Math.ceil(plan.plannedSec / 60) : 0;
	return `Due today: ${plan.due}. Planned: ${plural(plan.items.length, "item", "items")}, about ${minutes} min. Deferred to tomorrow: ${plan.deferred.length}.`;
}

/**
 * What the runner says when no card is left. Mirrors the agent's wording rule
 * (review-instructions.ts): how many items were deferred to tomorrow and which
 * nodes still need a card.
 */
export function emptyText(plan: PlanView): string {
	const parts = ["Nothing left to review today"];
	if (plan.deferred.length > 0) parts.push(`${plural(plan.deferred.length, "item", "items")} deferred to tomorrow`);
	let text = `${parts.join("; ")}.`;
	if (plan.needsCard.length > 0) text += ` Nodes that still need a card: ${plan.needsCard.map((n) => n.name).join(", ")}.`;
	const conversations = conversationCount(plan);
	if (conversations > 0) text += ` ${plural(conversations, "item needs", "items need")} a conversation and is not part of this card review.`;
	return text;
}

/** Body of POST /api/ext/review/answer: the learner's rating and the seconds the card was open. */
export function answerBody(nodeId: string, rating: Rating, durationSec: number): { nodeId: string; rating: Rating; durationSec: number } {
	return { nodeId, rating, durationSec };
}

/** Seconds from the moment a card was shown to now, never below one second. */
export function secondsSince(shownAtMs: number, nowMs: number): number {
	return Math.max(1, Math.round((nowMs - shownAtMs) / 1000));
}

/** Body of POST /api/ext/review/session for "Ask the tutor" on one card. */
export function askTutorBody(cardId: string): { cardId: string } {
	return { cardId };
}

export interface CardView {
	id: string;
	nodeId: string;
	question: string;
	answer: string;
	author: "user" | "agent";
	status: "draft" | "active" | "retired";
}

export interface NodeCards {
	nodeId: string;
	name: string;
	cards: CardView[];
}

/** Cards grouped by node, the node named from the graph (its id when the graph does not know it), groups sorted by name. */
export function groupCardsByNode(cards: readonly CardView[], names: ReadonlyMap<string, string>): NodeCards[] {
	const byNode = new Map<string, CardView[]>();
	for (const c of cards) byNode.set(c.nodeId, [...(byNode.get(c.nodeId) ?? []), c]);
	return [...byNode.entries()]
		.map(([nodeId, group]) => ({ nodeId, name: names.get(nodeId) ?? nodeId, cards: group }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The actions a card row offers: a draft is approved or rejected (retired), an active card can be retired. */
export function cardActions(card: CardView): Array<"approve" | "retire"> {
	if (card.status === "draft") return ["approve", "retire"];
	if (card.status === "active") return ["retire"];
	return [];
}

export const CARD_STATUS_LABEL: Record<CardView["status"], string> = { draft: "Draft", active: "Active", retired: "Retired" };

/** The message a failed request shows: the server's own fixed message, or the generic one. */
export function errorText(json: Record<string, unknown>): string {
	return typeof json.error === "string" ? json.error : REQUEST_FAILED;
}

/** The card editor can submit only when a node is chosen and the question and answer are not blank. */
export function cardFormReady(nodeId: string, question: string, answer: string): boolean {
	return nodeId !== "" && question.trim() !== "" && answer.trim() !== "";
}
