// src/core/ext/review-state.ts
/**
 * Review state is DERIVED, never stored (REQ-pl-04, REQ-pl-16): replay
 * review.jsonl in file order. `deriveMarks` folds the user's manual events;
 * `deriveNodeStates` folds the FSRS state per node. Both are pure and
 * deterministic for the same events and options.
 */

import { implicitCredit, newCard, reviewCard, type FsrsCard } from "./fsrs.ts";
import type { ReviewEvent } from "./review.ts";

export interface Marks {
	pinned: Set<string>;
	retired: Set<string>;
	/** Channel the user fixed for a node (absent = automatic assignment). */
	channelPin: Map<string, "fixed" | "dialogic">;
	/** Per-goal desired retention override (latest event wins). */
	retention: Map<string, number>;
}

export function deriveMarks(events: readonly ReviewEvent[]): Marks {
	const marks: Marks = { pinned: new Set(), retired: new Set(), channelPin: new Map(), retention: new Map() };
	for (const e of events) {
		if (e.type === "pin") {
			if (e.pinned) marks.pinned.add(e.nodeId);
			else marks.pinned.delete(e.nodeId);
		} else if (e.type === "retire") {
			if (e.retired) marks.retired.add(e.nodeId);
			else marks.retired.delete(e.nodeId);
		} else if (e.type === "channel") {
			if (e.channel === null) marks.channelPin.delete(e.nodeId);
			else marks.channelPin.set(e.nodeId, e.channel);
		} else if (e.type === "retention") {
			marks.retention.set(e.goalId, e.retention);
		}
	}
	return marks;
}

export interface NodeState {
	nodeId: string;
	card: FsrsCard;
	/** Number of real fixed-channel reviews (drives variant rotation). */
	fixedReviews: number;
}

export interface StateOptions {
	retentionOf(nodeId: string): number;
	/** Events for nodes this returns false for (deleted nodes) are ignored. */
	exists(nodeId: string): boolean;
	/** `w` of the implicit-repetition formula. */
	implicitWeight: number;
}

export const DEFAULT_IMPLICIT_WEIGHT = 0.5;

export function deriveNodeStates(events: readonly ReviewEvent[], opts: StateOptions): Map<string, NodeState> {
	const states = new Map<string, NodeState>();
	for (const e of events) {
		if (e.type === "review") {
			if (!opts.exists(e.nodeId)) continue;
			const prev = states.get(e.nodeId);
			const card = reviewCard(prev?.card ?? newCard(e.at), e.rating, e.at, opts.retentionOf(e.nodeId));
			states.set(e.nodeId, {
				nodeId: e.nodeId,
				card,
				fixedReviews: (prev?.fixedReviews ?? 0) + (e.channel === "fixed" ? 1 : 0),
			});
		} else if (e.type === "implicit") {
			if (!opts.exists(e.nodeId)) continue;
			const prev = states.get(e.nodeId);
			if (prev === undefined) continue; // an implicit event never creates a state
			const retention = opts.retentionOf(e.nodeId);
			const card =
				e.outcome === "credit"
					? implicitCredit(prev.card, e.at, retention, opts.implicitWeight)
					: reviewCard(prev.card, 1, e.at, retention);
			states.set(e.nodeId, { ...prev, card });
		}
	}
	return states;
}
