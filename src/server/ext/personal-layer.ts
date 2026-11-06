// src/server/ext/personal-layer.ts
/**
 * The personal layer's server surface (spec 2): one factory over injected
 * stores, so tests can drive it with memory stores, and one live instance
 * for the routes and the chat handler. Routes (app/api/ext/**) are thin
 * transport over `personalLayer`; the chat handler takes
 * `personalLayer.reviewToolContext` for `review` sessions.
 */

import type { ReviewToolContext } from "../../agent/ext/review-tools.ts";
import type { ReviewFocus, ReviewNodeFocus } from "../../agent/ext/review-instructions.ts";
import { deriveCards, pickVariant } from "../../core/ext/cards.ts";
import { deriveExplanations, type ExplanationEvent } from "../../core/ext/explanations.ts";
import type { DailyPlan } from "../../core/ext/daily-plan.ts";
import {
	computePlan,
	goalReadinessReport,
	nextItem,
	nodeReviewView,
	type QueryDeps,
} from "../../core/ext/review-queries.ts";
import { focusTargetOf, type FocusEvent, type FocusTarget } from "../../core/ext/review-focus.ts";
import {
	approveCard,
	createUserCard,
	proposeAgentCard,
	recordReview,
	ReviewInputError,
	retireCard,
	setChannelPin,
	setGoalRetention,
	setPinned,
	setRetired,
	type RecordReviewResult,
	type Snapshot,
} from "../../core/ext/review-service.ts";
import { stores } from "../stores.ts";
import { trustOfNode } from "./personal-trust.ts";
import { extStores } from "./stores.ts";
import { startOfLocalDay } from "../../core/ext/local-day.ts";

export { startOfLocalDay };

export interface PersonalLayerDeps extends QueryDeps {
	/** Creates a `kind: "review"` chat record. */
	createReviewChat(title: string): { id: string };
	/** What a tutor chat is about (a card or a node). Optional: without it no session can be focused. */
	focusLedger?: { append(event: FocusEvent): void; readAll(): FocusEvent[] };
	/** The node explanations, read for a node-focused session. Optional: without it the tutor has no explanation to show. */
	explanations?: { readEvents(): ExplanationEvent[] };
	dayStart?: () => string;
}

export type MarkRequest =
	| { nodeId: string; pinned: boolean }
	| { nodeId: string; retired: boolean }
	| { nodeId: string; channel: "fixed" | "dialogic" | null }
	| { goalId: string; retention: number };

const nowIso = (deps: PersonalLayerDeps): string => (deps.now ? deps.now() : new Date().toISOString());

/** What a tutor chat is focused on (a card or a node), or null for an ordinary session. */
function focusTargetFor(deps: PersonalLayerDeps, chatId: string): FocusTarget | null {
	if (deps.focusLedger === undefined) return null;
	return focusTargetOf(deps.focusLedger.readAll(), chatId);
}

/** The card and its node a focused tutor chat is about, or null. */
function cardFocusOf(deps: PersonalLayerDeps, cardId: string): ReviewFocus | null {
	const card = deriveCards(deps.cardsStore.readEvents()).find((c) => c.id === cardId);
	if (card === undefined) return null;
	const node = deps.graphStore.readNodes().find((n) => n.id === card.nodeId);
	return {
		nodeId: card.nodeId,
		nodeName: node?.name ?? card.nodeId,
		nodeStatement: node?.statement ?? "",
		question: card.question,
		answer: card.answer,
	};
}

/** The node a tutor chat about a node without a card is about, or null. */
function nodeFocusOf(deps: PersonalLayerDeps, nodeId: string): ReviewNodeFocus | null {
	const node = deps.graphStore.readNodes().find((n) => n.id === nodeId);
	if (node === undefined) return null;
	const explanation = deps.explanations ? deriveExplanations(deps.explanations.readEvents()).get(nodeId)?.current?.body : undefined;
	return { nodeId, nodeName: node.name, nodeStatement: node.statement, ...(explanation !== undefined ? { explanation } : {}) };
}

/** The focus fields of the tutor context: exactly one of them is set for a focused chat. */
function focusFieldsOf(deps: PersonalLayerDeps, chatId: string): { focus: ReviewFocus | null; nodeFocus: ReviewNodeFocus | null } {
	const target = focusTargetFor(deps, chatId);
	if (target === null) return { focus: null, nodeFocus: null };
	if (target.kind === "card") return { focus: cardFocusOf(deps, target.cardId), nodeFocus: null };
	return { focus: null, nodeFocus: nodeFocusOf(deps, target.nodeId) };
}

/** The plan's nodes that have no active card (see nodesWithoutCard). */
function withoutCardOf(plan: DailyPlan, snap: Snapshot): Array<{ nodeId: string; name: string }> {
	const nameOf = (id: string) => snap.nodes.find((n) => n.id === id)?.name ?? id;
	const dialogic = plan.items
		.filter((i) => i.channel === "dialogic" && pickVariant(snap.cards, i.nodeId, 0) === undefined)
		.map((i) => ({ nodeId: i.nodeId, name: nameOf(i.nodeId) }));
	return [...dialogic, ...plan.needsCard.map((id) => ({ nodeId: id, name: nameOf(id) }))];
}

export function createPersonalLayer(deps: PersonalLayerDeps) {
	const dayStart = deps.dayStart ?? (() => startOfLocalDay());
	return {
		/** Today's plan with node names, the card to show for each fixed item, and per-goal readiness for the exercise set. */
		plan() {
			const { plan, snap } = computePlan(deps, dayStart());
			const nameOf = (id: string) => snap.nodes.find((n) => n.id === id)?.name ?? id;
			const view = (i: (typeof plan.items)[number]) => ({ ...i, name: nameOf(i.nodeId) });
			const withCard = (i: (typeof plan.items)[number]) => {
				const base = view(i);
				if (i.channel !== "fixed") return base;
				const v = pickVariant(snap.cards, i.nodeId, snap.states.get(i.nodeId)?.fixedReviews ?? 0);
				return v === undefined ? base : { ...base, card: { cardId: v.id, question: v.question, answer: v.answer } };
			};
			return {
				items: plan.items.map(withCard),
				deferred: plan.deferred.map(view),
				needsCard: plan.needsCard.map((id) => ({ nodeId: id, name: nameOf(id) })),
				withoutCard: withoutCardOf(plan, snap),
				due: plan.due,
				capacity: plan.capacity,
				newQuota: plan.newQuota,
				remainingSec: plan.remainingSec,
				plannedSec: plan.plannedSec,
				goals: goalReadinessReport(deps),
			};
		},

		/**
		 * The nodes of today's plan that have no active card: the dialogic items without one, then the
		 * fixed items that still need one (needsCard). Each is named from the graph, its id when unknown.
		 */
		nodesWithoutCard(): Array<{ nodeId: string; name: string }> {
			const { plan, snap } = computePlan(deps, dayStart());
			return withoutCardOf(plan, snap);
		},

		/** Every graph node, for the card editor (id and name). */
		nodeList(): Array<{ id: string; name: string }> {
			return deps.graphStore
				.readNodes()
				.map((n) => ({ id: n.id, name: n.name }))
				.sort((a, b) => a.name.localeCompare(b.name));
		},

		/**
		 * Records the learner's rating of a CARD item of today's plan, through the same
		 * recordReview the review agent uses. A node that is not a fixed item of today's
		 * plan (not due, deferred, or dialogic) is refused, as the agent refuses an unpresented node.
		 */
		answerCard(input: { nodeId: string; rating: number; durationSec: number }): RecordReviewResult {
			const { plan } = computePlan(deps, dayStart());
			const item = plan.items.find((i) => i.nodeId === input.nodeId);
			if (item === undefined || item.channel !== "fixed") {
				throw new ReviewInputError("invalid", "this node is not a card item of today's plan");
			}
			return recordReview({ nodeId: input.nodeId, channel: "fixed", rating: input.rating, durationSec: input.durationSec }, deps);
		},

		nodeReview(nodeId: string) {
			return nodeReviewView(deps, nodeId);
		},

		/** A daily-review session, or (with a card) a tutor session focused on that card. */
		startReviewSession(cardId?: string): { chatId: string } {
			if (cardId === undefined) return { chatId: deps.createReviewChat("Daily review").id };
			const card = deriveCards(deps.cardsStore.readEvents()).find((c) => c.id === cardId);
			if (card === undefined) throw new ReviewInputError("unknown", "unknown card");
			if (deps.focusLedger === undefined) throw new ReviewInputError("invalid", "focused sessions are not available");
			const nodeName = deps.graphStore.readNodes().find((n) => n.id === card.nodeId)?.name ?? card.nodeId;
			const { id } = deps.createReviewChat(`Ask: ${nodeName}`);
			deps.focusLedger.append({ type: "focus", chatId: id, cardId, at: nowIso(deps) });
			return { chatId: id };
		},

		/** A tutor session focused on one node that has no card ("With the tutor"). It never runs the daily loop. */
		startNodeSession(nodeId: string): { chatId: string } {
			const node = deps.graphStore.readNodes().find((n) => n.id === nodeId);
			if (node === undefined) throw new ReviewInputError("unknown", "unknown node");
			if (deps.focusLedger === undefined) throw new ReviewInputError("invalid", "focused sessions are not available");
			const { id } = deps.createReviewChat(`Ask: ${node.name}`);
			deps.focusLedger.append({ type: "focus", chatId: id, nodeId, at: nowIso(deps) });
			return { chatId: id };
		},

		listCards(nodeId?: string) {
			const cards = deriveCards(deps.cardsStore.readEvents());
			return nodeId === undefined ? cards : cards.filter((c) => c.nodeId === nodeId);
		},

		createCard(input: { nodeId: string; question: string; answer: string }): { cardId: string } {
			return { cardId: createUserCard(input, deps) };
		},

		cardAction(cardId: string, action: "approve" | "retire"): void {
			if (action === "approve") approveCard(cardId, deps);
			else retireCard(cardId, deps);
		},

		mark(req: MarkRequest): void {
			if ("goalId" in req) setGoalRetention(req.goalId, req.retention, deps);
			else if ("pinned" in req) setPinned(req.nodeId, req.pinned, deps);
			else if ("retired" in req) setRetired(req.nodeId, req.retired, deps);
			else setChannelPin(req.nodeId, req.channel, deps);
		},

		reviewToolContext(chatId: string, chatStore: ReviewToolContext["chatStore"]): ReviewToolContext {
			return {
				chatId,
				chatStore,
				nextItem: () => nextItem(deps, dayStart()),
				record: (input) => recordReview(input, deps),
				proposeCard: (input) => proposeAgentCard(input, deps),
				...focusFieldsOf(deps, chatId),
			};
		},
	};
}

export type PersonalLayer = ReturnType<typeof createPersonalLayer>;

export const personalLayer = createPersonalLayer({
	graphStore: stores.graphStore,
	goalsStore: extStores.goalsStore,
	reviewStore: extStores.reviewStore,
	cardsStore: extStores.cardsStore,
	trustOf: trustOfNode,
	createReviewChat: (title) => stores.chatStore.createChat(title, "review"),
	focusLedger: extStores.reviewFocusLedger,
	explanations: extStores.explanationsStore,
});
