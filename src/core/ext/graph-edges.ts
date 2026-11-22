// src/core/ext/graph-edges.ts
/**
 * The graph view's edge list: chain arrows and typed links as ONE list.
 * Pure: no IO. Chains keep their own style key (CHAIN_STYLE); every link
 * type has its own style key (link:<type>), so the view colours and
 * legends them by style alone. A link whose endpoint is not a drawn node
 * is dropped: links can dangle after a rollback.
 */

import { LINK_TYPES, type LinkType } from "./links.ts";

export const CHAIN_STYLE = "chain";

/** Chain arrows only: layout physics and cluster regions read these, so links never move the layout. An edge with no style is a chain (legacy callers). */
export const isChainEdge = (e: { style?: string }): boolean => (e.style ?? CHAIN_STYLE) === CHAIN_STYLE;

export interface PlainEdge {
	from: string;
	to: string;
}

export interface StyledEdge extends PlainEdge {
	style: string;
	directed: boolean;
}

export function linkStyle(linkType: LinkType): string {
	return `link:${linkType}`;
}

export function edgesFor(
	chains: readonly PlainEdge[],
	links: ReadonlyArray<{ from: string; to: string; linkType: LinkType; directed: boolean }>,
	nodeIds: ReadonlySet<string>,
): StyledEdge[] {
	const out: StyledEdge[] = chains.map((e) => ({ from: e.from, to: e.to, style: CHAIN_STYLE, directed: true }));
	for (const link of links) {
		if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) continue;
		out.push({ from: link.from, to: link.to, style: linkStyle(link.linkType), directed: link.directed });
	}
	return out;
}

/** The link types present in an edge list, in LINK_TYPES order (chains never appear). */
export function legendFor(edges: readonly Pick<StyledEdge, "style">[]): LinkType[] {
	const present = new Set(edges.map((e) => e.style));
	return LINK_TYPES.filter((t) => present.has(linkStyle(t)));
}
