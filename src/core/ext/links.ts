// src/core/ext/links.ts
/**
 * Typed links (graph x study, typed edges): a registry of TYPED LINKS between
 * two existing graph nodes. It is SEPARATE from chains: chains say premises
 * jointly entail a conclusion and are never changed here. Links are an event
 * log (store events, derive state); this module is pure: no IO, no clock.
 */

export const LINK_TYPES = ["evolution", "sequence", "case-of", "part-of", "analogy", "contrast"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

const DIRECTED_TYPES: ReadonlySet<LinkType> = new Set<LinkType>(["evolution", "sequence", "case-of", "part-of"]);

/** Directed links have a from→to meaning; analogy and contrast are symmetric. */
export function isDirected(type: LinkType): boolean {
	return DIRECTED_TYPES.has(type);
}

export type LinkOrigin = "extractor" | "agent" | "user";
const ORIGINS: ReadonlySet<string> = new Set<LinkOrigin>(["extractor", "agent", "user"]);
const TYPES: ReadonlySet<string> = new Set<string>(LINK_TYPES);

export type LinkEvent =
	| { type: "created"; id: string; from: string; to: string; linkType: LinkType; origin: LinkOrigin; at: string }
	| { type: "removed"; id: string; at: string };

export interface Link {
	id: string;
	from: string;
	to: string;
	linkType: LinkType;
	directed: boolean;
	origin: LinkOrigin;
	createdAt: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Parses one raw ledger line. Null on any malformed input: the ledger skips it. */
export function parseLinkEvent(raw: unknown): LinkEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isNonEmptyString(r.id) || !isNonEmptyString(r.at)) return null;
	if (r.type === "removed") return { type: "removed", id: r.id, at: r.at };
	if (r.type !== "created") return null;
	if (!isNonEmptyString(r.from) || !isNonEmptyString(r.to)) return null;
	if (typeof r.linkType !== "string" || !TYPES.has(r.linkType)) return null;
	if (typeof r.origin !== "string" || !ORIGINS.has(r.origin)) return null;
	return {
		type: "created",
		id: r.id,
		from: r.from,
		to: r.to,
		linkType: r.linkType as LinkType,
		origin: r.origin as LinkOrigin,
		at: r.at,
	};
}

/** Two links are the same relation: same type and endpoints, reversed too when the type is undirected. */
function sameRelation(a: { from: string; to: string; linkType: LinkType }, b: { from: string; to: string; linkType: LinkType }): boolean {
	if (a.linkType !== b.linkType) return false;
	if (a.from === b.from && a.to === b.to) return true;
	return !isDirected(a.linkType) && a.from === b.to && a.to === b.from;
}

/** Problems with adding a link (empty = valid). Pure: the caller supplies the node ids and the live links. */
export function validateLink(
	candidate: { from: string; to: string; linkType: string },
	nodeIds: ReadonlySet<string>,
	existing: readonly Link[],
): string[] {
	const problems: string[] = [];
	if (!TYPES.has(candidate.linkType)) problems.push(`unknown link type "${candidate.linkType}"`);
	if (!nodeIds.has(candidate.from)) problems.push(`from "${candidate.from}" is not a known node`);
	if (!nodeIds.has(candidate.to)) problems.push(`to "${candidate.to}" is not a known node`);
	if (candidate.from === candidate.to) problems.push("a link cannot connect a node to itself");
	if (problems.length > 0) return problems;
	const linkType = candidate.linkType as LinkType;
	if (existing.some((l) => sameRelation(l, { from: candidate.from, to: candidate.to, linkType }))) {
		problems.push(`a ${linkType} link between these nodes already exists`);
	}
	return problems;
}

/** Replays the events in order. A removed id disappears; a removal of an unknown id and a repeated created id are ignored. */
export function deriveLinks(events: readonly LinkEvent[]): Link[] {
	const links = new Map<string, Link>();
	for (const e of events) {
		if (e.type === "created") {
			if (links.has(e.id)) continue;
			links.set(e.id, {
				id: e.id,
				from: e.from,
				to: e.to,
				linkType: e.linkType,
				directed: isDirected(e.linkType),
				origin: e.origin,
				createdAt: e.at,
			});
		} else {
			links.delete(e.id);
		}
	}
	return [...links.values()];
}

/** The write side the merger needs (core stays free of the adapter): the
 *  server's links store satisfies it structurally. */
export interface LinkSink {
	readLinks(): Link[];
	appendLink(input: { from: string; to: string; linkType: LinkType; origin: LinkOrigin }, nodeIds: ReadonlySet<string>): unknown;
	/** Re-points stored links after nodes merged (merged id → survivor id). */
	remapNodes(mergedIntoId: ReadonlyMap<string, string>): void;
}

/**
 * Re-points links after nodes were merged (`mergedIntoId`: merged id → survivor id).
 * A link that becomes a self-link is dropped; links that become the same relation
 * are de-duplicated, keeping the first in order.
 */
export function remapLinks(links: readonly Link[], mergedIntoId: ReadonlyMap<string, string>): Link[] {
	const out: Link[] = [];
	for (const link of links) {
		const from = mergedIntoId.get(link.from) ?? link.from;
		const to = mergedIntoId.get(link.to) ?? link.to;
		if (from === to) continue;
		const remapped: Link = { ...link, from, to };
		if (out.some((k) => sameRelation(k, remapped))) continue;
		out.push(remapped);
	}
	return out;
}
