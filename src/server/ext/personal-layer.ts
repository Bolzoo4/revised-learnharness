// src/server/ext/personal-layer.ts
/**
 * The personal layer's server surface (spec 2): one factory over injected
 * stores, so tests can drive it with memory stores, and one live instance
 * for the routes and the chat handler. Routes (app/api/ext/**) are thin
 * transport over `personalLayer`; the chat handler takes
 * `personalLayer.reviewToolContext` for `review` sessions.
 */

import type { ReviewToolContext } from "../../agent/ext/review-tools.ts";
import { deriveCards } from "../../core/ext/cards.ts";
import {
	computePlan,
	goalReadinessReport,
	nextItem,
	nodeReviewView,
	type QueryDeps,
} from "../../core/ext/review-queries.ts";
import {
	approveCard,
	createUserCard,
	proposeAgentCard,
	recordReview,
	retireCard,
	setChannelPin,
	setGoalRetention,
	setPinned,
	setRetired,
} from "../../core/ext/review-service.ts";
import { stores } from "../stores.ts";
import { trustOfNode } from "./personal-trust.ts";
import { extStores } from "./stores.ts";

/** Local midnight as an ISO instant: "today" for the daily budget and the dialogic cap. */
export function startOfLocalDay(now: Date = new Date()): string {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.toISOString();
}

export interface PersonalLayerDeps extends QueryDeps {
	/** Creates a `kind: "review"` chat record. */
	createReviewChat(title: string): { id: string };
	dayStart?: () => string;
}

export type MarkRequest =
	| { nodeId: string; pinned: boolean }
	| { nodeId: string; retired: boolean }
	| { nodeId: string; channel: "fixed" | "dialogic" | null }
	| { goalId: string; retention: number };

export function createPersonalLayer(deps: PersonalLayerDeps) {
	const dayStart = deps.dayStart ?? (() => startOfLocalDay());
	return {
		/** Today's plan with node names, plus per-goal readiness for the exercise set. */
		plan() {
			const { plan, snap } = computePlan(deps, dayStart());
			const nameOf = (id: string) => snap.nodes.find((n) => n.id === id)?.name ?? id;
			const view = (i: (typeof plan.items)[number]) => ({ ...i, name: nameOf(i.nodeId) });
			return {
				items: plan.items.map(view),
				deferred: plan.deferred.map(view),
				needsCard: plan.needsCard.map((id) => ({ nodeId: id, name: nameOf(id) })),
				due: plan.due,
				capacity: plan.capacity,
				newQuota: plan.newQuota,
				remainingSec: plan.remainingSec,
				goals: goalReadinessReport(deps),
			};
		},

		nodeReview(nodeId: string) {
			return nodeReviewView(deps, nodeId);
		},

		startReviewSession(): { chatId: string } {
			return { chatId: deps.createReviewChat("Daily review").id };
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
	createReviewChat: (title) => stores.chatStore.createChat(title, "review" as never), // TEMP until Task 11 widens the kind
});
