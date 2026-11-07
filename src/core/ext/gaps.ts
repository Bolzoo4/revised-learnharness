// src/core/ext/gaps.ts
/**
 * Gap finding and scoring (REQ-rs-02, REQ-rs-03). Pure and deterministic:
 * identical input yields an identical ordered list.
 *
 *   score = priority x typeWeight x distanceBase^distance   (x expandBoost under an `expand` mark)
 *
 * `priority` and `distance` come from the active goals: for every active goal a
 * breadth-first walk from its scope (distance 0) over the chains, undirected,
 * gives each reachable node a best weight priority x distanceBase^distance.
 * Marks filter (REQ-rs-03) and carry the depth limit (REQ-rs-05).
 *
 * Scoring follows the winning (highest-weight) goal, but eligibility (distance-0
 * gap types, depth limit) uses the minimum distance over all active goals, so a
 * higher-priority goal reaching a node farther cannot hide it from a goal whose
 * scope contains it. Uncovered-chat gaps ignore marks (chats have no node) and
 * are deduplicated by chat id. Candidates with a non-finite score are skipped.
 */

import type { Goal } from "./goals.ts";
import { DEFAULT_GOAL_PRIORITY, goalScope } from "./goals.ts";
import { createMarkResolver, frontierMode, modeAllows, type Mark } from "./frontier.ts";
import { GAP_CLASS, type GapClass, type GapType, type ResearchConfig } from "./research-config.ts";
import type { ChainLite, GraphNodeLite, TrustInfo, UncoveredChat } from "./research-ports.ts";

export interface Gap {
	/** `${type}:${nodeId | chatId}` */
	id: string;
	type: GapType;
	class: GapClass;
	nodeId?: string;
	chatId?: string;
	/** Human-readable subject: the node's name or the chat's title. */
	label: string;
	distance: number;
	score: number;
	/** The mark that governed this gap, if any. */
	markId?: string;
}

export interface GapInput {
	goals: readonly Goal[];
	chains: readonly ChainLite[];
	nodes: readonly Pick<GraphNodeLite, "id" | "name">[];
	/** Derived trust per node; a missing node reads as unverified without primary support. */
	trust: ReadonlyMap<string, TrustInfo>;
	weakNodeIds: readonly string[];
	uncovered: readonly UncoveredChat[];
	marks: readonly Mark[];
	/** USD spent per mark id (from the research log), for budgets. */
	markSpendUsd: ReadonlyMap<string, number>;
	config: ResearchConfig;
}

interface Reach {
	/** Highest weight over the active goals. */
	weight: number;
	/** Distance at which the winning goal reaches the node (scoring). */
	distance: number;
	/** Minimum distance over all active goals (eligibility). */
	minDistance: number;
}

/** Best weight and its distance for every node reachable from the active goals' scopes. */
export function reachFromGoals(goals: readonly Goal[], chains: readonly ChainLite[], distanceBase: number): Map<string, Reach> {
	const neighbours = new Map<string, string[]>();
	const link = (a: string, b: string) => {
		const list = neighbours.get(a);
		if (list === undefined) neighbours.set(a, [b]);
		else list.push(b);
	};
	for (const chain of chains) {
		for (const premise of chain.premises) {
			link(premise, chain.conclusion);
			link(chain.conclusion, premise);
		}
	}
	const best = new Map<string, Reach>();
	for (const goal of goals) {
		if (goal.status !== "active") continue;
		const dist = new Map<string, number>();
		let frontier = goalScope(goal.targetNodeIds, chains);
		for (const id of frontier) dist.set(id, 0);
		for (let d = 0; frontier.length > 0; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const other of neighbours.get(id) ?? []) {
					if (dist.has(other)) continue;
					dist.set(other, d + 1);
					next.push(other);
				}
			}
			frontier = next;
		}
		for (const [id, distance] of dist) {
			const weight = goal.priority * Math.pow(distanceBase, distance);
			const prev = best.get(id);
			if (prev === undefined) {
				best.set(id, { weight, distance, minDistance: distance });
				continue;
			}
			const minDistance = Math.min(prev.minDistance, distance);
			if (weight > prev.weight || (weight === prev.weight && distance < prev.distance)) {
				best.set(id, { weight, distance, minDistance });
			} else prev.minDistance = minDistance;
		}
	}
	return best;
}

/**
 * The one gap of a goal cycle (REQ-rs-19): the learner's goal stands in for a node. It is not
 * scored, so its score is 0; `id` is the cycle's own id, since there is no node or chat to key it.
 */
export function goalGap(goal: string, id: string): Gap {
	return { id, type: "goal", class: GAP_CLASS.goal, label: goal, distance: 0, score: 0 };
}

export function findGaps(input: GapInput): Gap[] {
	const { config } = input;
	const reach = reachFromGoals(input.goals, input.chains, config.distanceBase);
	const resolver = createMarkResolver(input.marks, input.goals, input.chains);
	const names = new Map(input.nodes.map((n) => [n.id, n.name]));
	const concluded = new Set(input.chains.map((c) => c.conclusion));
	const trustOf = (id: string): TrustInfo => input.trust.get(id) ?? { trust: "unverified", hasPrimarySupport: false };

	const candidates: Array<{ type: GapType; nodeId: string }> = [];
	for (const [id, r] of reach) {
		if (!names.has(id)) continue;
		if (r.minDistance === 0) {
			if (!concluded.has(id)) candidates.push({ type: "no-premises", nodeId: id });
			if (trustOf(id).trust === "unverified") candidates.push({ type: "unverified", nodeId: id });
		}
		const t = trustOf(id);
		if (t.trust === "contested" && !t.hasPrimarySupport) candidates.push({ type: "contested-no-primary", nodeId: id });
	}
	for (const id of input.weakNodeIds) {
		if (reach.has(id) && names.has(id)) candidates.push({ type: "weak-premise", nodeId: id });
	}

	const bestPerNode = new Map<string, Gap>();
	for (const c of candidates) {
		const r = reach.get(c.nodeId)!;
		const mark = resolver.effective(c.nodeId);
		const mode = frontierMode(mark, mark === null ? 0 : (input.markSpendUsd.get(mark.id) ?? 0));
		if (!modeAllows(mode, GAP_CLASS[c.type])) continue;
		if (r.minDistance > (mark?.maxDepth ?? config.defaultMaxDepth)) continue;
		const score = r.weight * config.weights[c.type] * (mode === "expand" ? config.expandBoost : 1);
		if (!Number.isFinite(score)) continue;
		const gap: Gap = {
			id: `${c.type}:${c.nodeId}`,
			type: c.type,
			class: GAP_CLASS[c.type],
			nodeId: c.nodeId,
			label: names.get(c.nodeId) ?? c.nodeId,
			distance: r.distance,
			score,
			...(mark !== null ? { markId: mark.id } : {}),
		};
		const prev = bestPerNode.get(c.nodeId);
		if (prev === undefined || gap.score > prev.score || (gap.score === prev.score && gap.id < prev.id)) bestPerNode.set(c.nodeId, gap);
	}

	const activePriority = input.goals.filter((g) => g.status === "active").reduce((m, g) => Math.max(m, g.priority), 0);
	const chatPriority = activePriority > 0 ? activePriority : DEFAULT_GOAL_PRIORITY;
	const gaps: Gap[] = [...bestPerNode.values()];
	const seenChats = new Set<string>();
	const uncoveredScore = chatPriority * config.weights.uncovered;
	for (const chat of input.uncovered) {
		if (!(chat.messages > 0) || !Number.isFinite(uncoveredScore) || seenChats.has(chat.chatId)) continue;
		seenChats.add(chat.chatId);
		gaps.push({
			id: `uncovered:${chat.chatId}`,
			type: "uncovered",
			class: GAP_CLASS.uncovered,
			chatId: chat.chatId,
			label: chat.title,
			distance: 0,
			score: uncoveredScore,
		});
	}
	return gaps.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
