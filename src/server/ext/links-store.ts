// src/server/ext/links-store.ts
/**
 * The typed-link registry's adapter: appends link events to its ledger and
 * reads the derived links back. Validation and derivation are the pure
 * module's (core/ext/links.ts); the id generator and the clock are injected
 * so tests stay deterministic.
 */

import { randomUUID } from "node:crypto";
import {
	deriveLinks,
	isDirected,
	remapLinks,
	validateLink,
	type Link,
	type LinkEvent,
	type LinkOrigin,
	type LinkSink,
	type LinkType,
} from "../../core/ext/links.ts";
import type { Ledger } from "../../store/ext/ledger.ts";

export interface LinksStoreDeps {
	newId: () => string;
	now: () => string;
}

export interface NewLink {
	from: string;
	to: string;
	linkType: LinkType;
	origin: LinkOrigin;
}

export interface LinksStore extends LinkSink {
	/** Validates against the live links and the given node ids; throws with the problems, writes nothing on failure. */
	appendLink(input: NewLink, nodeIds: ReadonlySet<string>): Link;
	/** Throws when the id is not a live link. */
	appendRemoval(id: string): void;
	readLinks(): Link[];
	/** Moves links off merged-away node ids: a changed link is removed and re-created under a fresh id (the event log's created ids are immutable); a link that became a self-link or a duplicate is removed. */
	remapNodes(mergedIntoId: ReadonlyMap<string, string>): void;
}

const defaultDeps: LinksStoreDeps = {
	newId: () => `link_${randomUUID()}`,
	now: () => new Date().toISOString(),
};

export function createLinksStore(ledger: Ledger<LinkEvent>, deps: LinksStoreDeps = defaultDeps): LinksStore {
	const store: LinksStore = {
		appendLink(input, nodeIds) {
			const existing = deriveLinks(ledger.readAll());
			const problems = validateLink(input, nodeIds, existing);
			if (problems.length > 0) throw new Error(`invalid link: ${problems.join("; ")}`);
			const id = deps.newId();
			const at = deps.now();
			ledger.append({ type: "created", id, from: input.from, to: input.to, linkType: input.linkType, origin: input.origin, at });
			return {
				id,
				from: input.from,
				to: input.to,
				linkType: input.linkType,
				directed: isDirected(input.linkType),
				origin: input.origin,
				createdAt: at,
			};
		},
		appendRemoval(id) {
			if (!deriveLinks(ledger.readAll()).some((l) => l.id === id)) throw new Error(`no live link with id ${id}`);
			ledger.append({ type: "removed", id, at: deps.now() });
		},
		readLinks() {
			return deriveLinks(ledger.readAll());
		},
		remapNodes(mergedIntoId) {
			if (mergedIntoId.size === 0) return;
			const before = deriveLinks(ledger.readAll());
			const after = new Map(remapLinks(before, mergedIntoId).map((l) => [l.id, l]));
			const at = deps.now();
			for (const link of before) {
				const kept = after.get(link.id);
				if (kept && kept.from === link.from && kept.to === link.to) continue;
				ledger.append({ type: "removed", id: link.id, at });
				if (kept) {
					ledger.append({ type: "created", id: deps.newId(), from: kept.from, to: kept.to, linkType: kept.linkType, origin: kept.origin, at });
				}
			}
		},
	};
	return store;
}
