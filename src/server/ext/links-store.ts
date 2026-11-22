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
	validateLink,
	type Link,
	type LinkEvent,
	type LinkOrigin,
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

export interface LinksStore {
	/** Validates against the live links and the given node ids; throws with the problems, writes nothing on failure. */
	appendLink(input: NewLink, nodeIds: ReadonlySet<string>): Link;
	/** Throws when the id is not a live link. */
	appendRemoval(id: string): void;
	readLinks(): Link[];
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
	};
	return store;
}
