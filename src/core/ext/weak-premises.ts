// src/core/ext/weak-premises.ts
/**
 * Premises "recorded as weak in reviews" (REQ-rs-02). A dialogic review event
 * lists the premises the dialogue found weak (personal-layer REQ-pl-15). A node
 * is weak when it was listed within the window (inclusive) and has not been
 * reviewed with rating 3 (good) or 4 (easy) strictly after the latest flag.
 * Pure; events with unreadable dates are ignored.
 */

import type { ReviewEvent } from "./review.ts";

export const WEAK_WINDOW_DAYS = 30;

export function weakPremiseNodeIds(events: readonly ReviewEvent[], nowIso: string, windowDays = WEAK_WINDOW_DAYS): string[] {
	const now = Date.parse(nowIso);
	if (Number.isNaN(now) || !Number.isFinite(windowDays) || windowDays <= 0) return [];
	const since = now - windowDays * 86_400_000;
	const lastWeak = new Map<string, number>();
	for (const e of events) {
		if (e.type !== "review" || e.channel !== "dialogic" || e.weakPremises === undefined) continue;
		const t = Date.parse(e.at);
		if (Number.isNaN(t) || t < since) continue;
		for (const id of e.weakPremises) {
			if (id === "") continue;
			if (t > (lastWeak.get(id) ?? Number.NEGATIVE_INFINITY)) lastWeak.set(id, t);
		}
	}
	for (const e of events) {
		if (e.type !== "review" || e.rating < 3) continue;
		const weakAt = lastWeak.get(e.nodeId);
		if (weakAt !== undefined && Date.parse(e.at) > weakAt) lastWeak.delete(e.nodeId);
	}
	return [...lastWeak.keys()].sort();
}
