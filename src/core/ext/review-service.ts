// src/core/ext/review-service.ts
/**
 * The write side of the personal layer. Every function validates BEFORE its
 * first write and appends events only to the extension ledgers (REQ-int-02:
 * the content graph is read-only here; learner errors never reach it,
 * REQ-pl-15).
 */

import { randomBytes } from "node:crypto";
import type { GraphStore } from "../ports.ts";
import { deriveCards, type ContentCard } from "./cards.ts";
import { claimNodes, premisesOf } from "./deck.ts";
import { deriveGoals, type Goal } from "./goals.ts";
import type { CardsStore, GoalsStore, ReviewStore } from "./ports.ts";
import { DEFAULT_IMPLICIT_WEIGHT, deriveMarks, deriveNodeStates, type Marks, type NodeState } from "./review-state.ts";
import { isValidRating, isValidRetention, type ReviewRating } from "./review.ts";
import { DEFAULT_RETENTION, recallProbability } from "./fsrs.ts";
import type { GraphChain, GraphNode } from "../contracts.ts";

export interface ReviewDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	goalsStore: GoalsStore;
	reviewStore: ReviewStore;
	cardsStore: CardsStore;
	now?: () => string;
	newCardId?: () => string;
	implicitWeight?: number;
}

/** A rejected input: "unknown" names a node, goal or card that does not exist; "invalid" is any other rule violation. Routes map the kind to 404 / 400. */
export class ReviewInputError extends Error {
	constructor(
		public readonly kind: "unknown" | "invalid",
		message: string,
	) {
		super(message);
		this.name = "ReviewInputError";
	}
}

export const nowOf = (deps: ReviewDeps): string => (deps.now ? deps.now() : new Date().toISOString());

/** Everything derived from the ledgers at one instant. */
export interface Snapshot {
	now: string;
	nodes: GraphNode[];
	nodeIds: Set<string>;
	chains: GraphChain[];
	goals: Goal[];
	marks: Marks;
	states: Map<string, NodeState>;
	cards: ContentCard[];
	recall: (nodeId: string) => number;
}

export function snapshot(deps: ReviewDeps, now: string): Snapshot {
	const nodes = deps.graphStore.readNodes();
	const nodeIds = new Set(nodes.map((n) => n.id));
	const chains = deps.graphStore.readChains();
	const goals = deriveGoals(deps.goalsStore.readEvents());
	const events = deps.reviewStore.readEvents();
	const marks = deriveMarks(events);
	// Retention uses EVERY goal (paused goals keep their nodes' state, REQ-pl-13).
	const info = claimNodes(goals, chains, marks);
	const states = deriveNodeStates(events, {
		retentionOf: (id) => info.get(id)?.retention ?? DEFAULT_RETENTION,
		exists: (id) => nodeIds.has(id),
		implicitWeight: deps.implicitWeight ?? DEFAULT_IMPLICIT_WEIGHT,
	});
	return {
		now,
		nodes,
		nodeIds,
		chains,
		goals,
		marks,
		states,
		cards: deriveCards(deps.cardsStore.readEvents()),
		recall: (id) => recallProbability(states.get(id)?.card ?? null, now),
	};
}

// ─── reviews ────────────────────────────────────────────────────────────────

export interface RecordReviewInput {
	nodeId: string;
	channel: "fixed" | "dialogic";
	rating: number;
	durationSec: number;
	question?: string;
	answer?: string;
	/** Dialogic only: premises the dialogue found weak (REQ-pl-15). */
	weakPremises?: string[];
}

export interface RecordReviewResult {
	dueAt: string;
	credited: string[];
	penalised: string[];
}

/**
 * One real review plus, for a dialogic review, its implicit events on the
 * premises (REQ-pl-09): success (rating >= 2, i.e. not "Again") credits
 * every premise NOT flagged weak; failure (rating 1) penalises ONLY the
 * premises flagged weak. A premise with no state yet is left alone.
 */
export function recordReview(input: RecordReviewInput, deps: ReviewDeps): RecordReviewResult {
	const now = nowOf(deps);
	const snap = snapshot(deps, now);
	if (!snap.nodeIds.has(input.nodeId)) throw new ReviewInputError("unknown", `unknown node: ${input.nodeId}`);
	if (!isValidRating(input.rating)) throw new ReviewInputError("invalid", "rating must be 1, 2, 3 or 4");
	if (!Number.isFinite(input.durationSec) || input.durationSec < 0) throw new ReviewInputError("invalid", "durationSec must be >= 0");
	const weak = input.weakPremises ?? [];
	if (input.channel !== "dialogic" && weak.length > 0) throw new ReviewInputError("invalid", "only a dialogic review can flag weak premises");
	const premises = premisesOf(input.nodeId, snap.chains);
	for (const w of weak) if (!premises.includes(w)) throw new ReviewInputError("invalid", `weak premise ${w} is not a premise of ${input.nodeId}`);
	const rating: ReviewRating = input.rating;

	deps.reviewStore.appendEvent({
		type: "review",
		nodeId: input.nodeId,
		channel: input.channel,
		rating,
		durationSec: input.durationSec,
		at: now,
		...(input.question !== undefined ? { question: input.question } : {}),
		...(input.answer !== undefined ? { answer: input.answer } : {}),
		...(input.channel === "dialogic" ? { weakPremises: weak } : {}),
	});

	const credited: string[] = [];
	const penalised: string[] = [];
	if (input.channel === "dialogic") {
		const targets = rating >= 2 ? premises.filter((p) => !weak.includes(p)) : weak;
		for (const p of targets) {
			if (!snap.states.has(p)) continue;
			deps.reviewStore.appendEvent({
				type: "implicit",
				nodeId: p,
				viaNodeId: input.nodeId,
				outcome: rating >= 2 ? "credit" : "penalty",
				at: now,
			});
			(rating >= 2 ? credited : penalised).push(p);
		}
	}
	const after = snapshot(deps, now).states.get(input.nodeId);
	return { dueAt: (after?.card.due ?? new Date(now)).toISOString(), credited, penalised };
}

// ─── cards ──────────────────────────────────────────────────────────────────

function newCardId(deps: ReviewDeps): string {
	return deps.newCardId ? deps.newCardId() : `card_${randomBytes(6).toString("hex")}`;
}

function requireNode(deps: ReviewDeps, nodeId: string): void {
	if (!deps.graphStore.readNodes().some((n) => n.id === nodeId)) throw new ReviewInputError("unknown", `unknown node: ${nodeId}`);
}

/** REQ-pl-02: the user's own card is schedulable at once. */
export function createUserCard(input: { nodeId: string; question: string; answer: string }, deps: ReviewDeps): string {
	requireNode(deps, input.nodeId);
	const cardId = newCardId(deps);
	deps.cardsStore.appendEvent({ type: "created", cardId, ...input, author: "user", status: "active", at: nowOf(deps) });
	return cardId;
}

/** REQ-pl-03: an agent's card is a draft until the user approves it. */
export function proposeAgentCard(input: { nodeId: string; question: string; answer: string }, deps: ReviewDeps): string {
	requireNode(deps, input.nodeId);
	const cardId = newCardId(deps);
	deps.cardsStore.appendEvent({ type: "created", cardId, ...input, author: "agent", status: "draft", at: nowOf(deps) });
	return cardId;
}

function cardById(deps: ReviewDeps, cardId: string): ContentCard {
	const card = deriveCards(deps.cardsStore.readEvents()).find((c) => c.id === cardId);
	if (card === undefined) throw new ReviewInputError("unknown", `unknown card: ${cardId}`);
	return card;
}

/** The user's approval of a draft. Only a draft can be approved. */
export function approveCard(cardId: string, deps: ReviewDeps): void {
	if (cardById(deps, cardId).status !== "draft") throw new ReviewInputError("invalid", "only a draft card can be approved");
	deps.cardsStore.appendEvent({ type: "status", cardId, status: "active", at: nowOf(deps) });
}

export function retireCard(cardId: string, deps: ReviewDeps): void {
	cardById(deps, cardId);
	deps.cardsStore.appendEvent({ type: "status", cardId, status: "retired", at: nowOf(deps) });
}

// ─── manual marks ───────────────────────────────────────────────────────────

export function setPinned(nodeId: string, pinned: boolean, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	const at = nowOf(deps);
	deps.reviewStore.appendEvent({ type: "pin", nodeId, pinned, at });
	if (pinned) deps.reviewStore.appendEvent({ type: "retire", nodeId, retired: false, at });
}

export function setRetired(nodeId: string, retired: boolean, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	const at = nowOf(deps);
	deps.reviewStore.appendEvent({ type: "retire", nodeId, retired, at });
	if (retired) deps.reviewStore.appendEvent({ type: "pin", nodeId, pinned: false, at });
}

/** REQ-pl-05: fix the channel of a node; null returns it to automatic assignment. */
export function setChannelPin(nodeId: string, channel: "fixed" | "dialogic" | null, deps: ReviewDeps): void {
	requireNode(deps, nodeId);
	deps.reviewStore.appendEvent({ type: "channel", nodeId, channel, at: nowOf(deps) });
}

/** REQ-pl-08: per-goal desired retention. */
export function setGoalRetention(goalId: string, retention: number, deps: ReviewDeps): void {
	if (!isValidRetention(retention)) throw new ReviewInputError("invalid", "retention must be between 0.7 and 0.97");
	if (!deriveGoals(deps.goalsStore.readEvents()).some((g) => g.id === goalId)) throw new ReviewInputError("unknown", `unknown goal: ${goalId}`);
	deps.reviewStore.appendEvent({ type: "retention", goalId, retention, at: nowOf(deps) });
}

// ─── goal completion ────────────────────────────────────────────────────────

export type ExerciseOutcome = "passed" | "weak" | "failed";

export interface ExerciseResult {
	goalId: string;
	results: Array<{ nodeId: string; outcome: ExerciseOutcome }>;
}

/**
 * REQ-pl-14 — the ONLY writer of a goal's `reached` status. Each per-node
 * outcome becomes an `exercise` review event ("passed" is Good; "weak" and
 * "failed" are Again, which makes the node due again). The goal is marked
 * reached only if every result passed AND the set covers every target node.
 */
export function applyExerciseResult(input: ExerciseResult, deps: ReviewDeps): { reached: boolean } {
	const goal = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === input.goalId);
	if (goal === undefined) throw new ReviewInputError("unknown", `unknown goal: ${input.goalId}`);
	if (goal.status !== "active") throw new ReviewInputError("invalid", "only an active goal can take an exercise result");
	if (input.results.length === 0) throw new ReviewInputError("invalid", "an exercise result needs at least one node");
	const known = new Set(deps.graphStore.readNodes().map((n) => n.id));
	for (const r of input.results) if (!known.has(r.nodeId)) throw new ReviewInputError("unknown", `unknown node: ${r.nodeId}`);
	const at = nowOf(deps);
	for (const r of input.results) {
		deps.reviewStore.appendEvent({
			type: "review",
			nodeId: r.nodeId,
			channel: "exercise",
			rating: r.outcome === "passed" ? 3 : 1,
			durationSec: 0,
			at,
		});
	}
	const allPassed = input.results.every((r) => r.outcome === "passed");
	const covered = goal.targetNodeIds.every((t) => input.results.some((r) => r.nodeId === t));
	const reached = allPassed && covered;
	if (reached) deps.goalsStore.appendEvent({ type: "status", goalId: goal.id, status: "reached", at });
	return { reached };
}
