// src/core/ext/panel-history.ts
/**
 * Back and forward history of the node panel (REQ-node-13). Immutable and
 * pure: every function returns a new value (or the same one when nothing
 * changes). Browser-safe.
 */

export interface PanelHistory {
	entries: readonly string[];
	/** Index of the current entry; -1 when empty. */
	index: number;
}

export const EMPTY_HISTORY: PanelHistory = { entries: [], index: -1 };

export function historyCurrent(h: PanelHistory): string | null {
	return h.entries[h.index] ?? null;
}

export const historyCanBack = (h: PanelHistory): boolean => h.index > 0;
export const historyCanForward = (h: PanelHistory): boolean => h.index < h.entries.length - 1;

/** Open a node; forward entries are dropped; re-opening the current node is a no-op. */
export function historyOpen(h: PanelHistory, nodeId: string): PanelHistory {
	if (historyCurrent(h) === nodeId) return h;
	return { entries: [...h.entries.slice(0, h.index + 1), nodeId], index: h.index + 1 };
}

export function historyBack(h: PanelHistory): PanelHistory {
	return historyCanBack(h) ? { entries: h.entries, index: h.index - 1 } : h;
}

export function historyForward(h: PanelHistory): PanelHistory {
	return historyCanForward(h) ? { entries: h.entries, index: h.index + 1 } : h;
}
