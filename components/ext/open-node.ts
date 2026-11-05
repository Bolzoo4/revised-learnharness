// components/ext/open-node.ts
/**
 * The one call every view uses to open the node panel (REQ-node-10): the
 * graph view, the chat graph-context card, and later the lecture view and
 * review. A window event keeps callers decoupled from the panel host
 * (upstream uses the same "lh:" event idiom for its cross-component signals).
 */

export const OPEN_NODE_EVENT = "lh:open-node";

export function openNodePanel(nodeId: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(OPEN_NODE_EVENT, { detail: { nodeId } }));
}
