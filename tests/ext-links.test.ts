// tests/ext-links.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	LINK_TYPES,
	deriveLinks,
	isDirected,
	parseLinkEvent,
	remapLinks,
	validateLink,
	type Link,
	type LinkEvent,
	type LinkType,
} from "../src/core/ext/links.ts";

const AT = "2026-11-20T10:00:00.000Z";

const nodeIds = new Set(["n_a", "n_b", "n_c"]);

// Raw strings are accepted so malformed input can be exercised; the parser is the gate, not the type.
const created = (id: string, from: string, to: string, linkType: string = "evolution", origin = "user"): LinkEvent =>
	({ type: "created", id, from, to, linkType, origin, at: AT }) as LinkEvent;

const link = (id: string, from: string, to: string, linkType: LinkType): Link => ({
	id,
	from,
	to,
	linkType,
	directed: isDirected(linkType),
	origin: "user",
	createdAt: AT,
});

describe("link types", () => {
	it("lists the six link types", () => {
		assert.deepEqual([...LINK_TYPES], ["evolution", "sequence", "case-of", "part-of", "analogy", "contrast"]);
	});

	it("marks evolution, sequence, case-of and part-of as directed", () => {
		for (const t of ["evolution", "sequence", "case-of", "part-of"] as const) assert.equal(isDirected(t), true, t);
	});

	it("marks analogy and contrast as undirected", () => {
		assert.equal(isDirected("analogy"), false);
		assert.equal(isDirected("contrast"), false);
	});
});

describe("parseLinkEvent", () => {
	it("accepts a well-formed created event", () => {
		const e = created("link_1", "n_a", "n_b", "analogy", "agent");
		assert.deepEqual(parseLinkEvent(e), e);
	});

	it("accepts a removed event", () => {
		const e = { type: "removed", id: "link_1", at: AT };
		assert.deepEqual(parseLinkEvent(e), e);
	});

	it("accepts each origin: extractor, agent, user", () => {
		for (const origin of ["extractor", "agent", "user"]) {
			assert.notEqual(parseLinkEvent(created("link_1", "n_a", "n_b", "sequence", origin)), null, origin);
		}
	});

	it("rejects an unknown linkType", () => {
		assert.equal(parseLinkEvent(created("link_1", "n_a", "n_b", "causes")), null);
	});

	it("rejects an unknown origin", () => {
		assert.equal(parseLinkEvent(created("link_1", "n_a", "n_b", "sequence", "chat")), null);
	});

	it("rejects empty strings in id, from, to and at", () => {
		assert.equal(parseLinkEvent({ ...created("link_1", "n_a", "n_b"), id: "" }), null);
		assert.equal(parseLinkEvent({ ...created("link_1", "n_a", "n_b"), from: "" }), null);
		assert.equal(parseLinkEvent({ ...created("link_1", "n_a", "n_b"), to: "" }), null);
		assert.equal(parseLinkEvent({ ...created("link_1", "n_a", "n_b"), at: "" }), null);
		assert.equal(parseLinkEvent({ type: "removed", id: "", at: AT }), null);
	});

	it("rejects non-objects, unknown discriminators and missing fields", () => {
		assert.equal(parseLinkEvent(null), null);
		assert.equal(parseLinkEvent("created"), null);
		assert.equal(parseLinkEvent(42), null);
		assert.equal(parseLinkEvent({ type: "status", id: "link_1", at: AT }), null);
		assert.equal(parseLinkEvent({ type: "removed", at: AT }), null);
	});
});

describe("validateLink", () => {
	it("returns no problems for a valid directed link", () => {
		assert.deepEqual(validateLink({ from: "n_a", to: "n_b", linkType: "evolution" }, nodeIds, []), []);
	});

	it("rejects an unknown linkType", () => {
		assert.notDeepEqual(validateLink({ from: "n_a", to: "n_b", linkType: "causes" as never }, nodeIds, []), []);
	});

	it("rejects a from that is not a known node", () => {
		assert.notDeepEqual(validateLink({ from: "n_x", to: "n_b", linkType: "sequence" }, nodeIds, []), []);
	});

	it("rejects a to that is not a known node", () => {
		assert.notDeepEqual(validateLink({ from: "n_a", to: "n_x", linkType: "sequence" }, nodeIds, []), []);
	});

	it("rejects a self-link", () => {
		assert.notDeepEqual(validateLink({ from: "n_a", to: "n_a", linkType: "analogy" }, nodeIds, []), []);
	});

	it("rejects a duplicate directed link with the same from, to and type", () => {
		const existing = [link("link_1", "n_a", "n_b", "part-of")];
		assert.notDeepEqual(validateLink({ from: "n_a", to: "n_b", linkType: "part-of" }, nodeIds, existing), []);
	});

	it("accepts the reversed pair of a directed link (direction matters)", () => {
		const existing = [link("link_1", "n_a", "n_b", "part-of")];
		assert.deepEqual(validateLink({ from: "n_b", to: "n_a", linkType: "part-of" }, nodeIds, existing), []);
	});

	it("rejects the same undirected pair in the same order", () => {
		const existing = [link("link_1", "n_a", "n_b", "analogy")];
		assert.notDeepEqual(validateLink({ from: "n_a", to: "n_b", linkType: "analogy" }, nodeIds, existing), []);
	});

	it("rejects the reversed pair of an undirected link", () => {
		const existing = [link("link_1", "n_a", "n_b", "contrast")];
		assert.notDeepEqual(validateLink({ from: "n_b", to: "n_a", linkType: "contrast" }, nodeIds, existing), []);
	});

	it("accepts the same pair with a different linkType", () => {
		const existing = [link("link_1", "n_a", "n_b", "analogy")];
		assert.deepEqual(validateLink({ from: "n_a", to: "n_b", linkType: "contrast" }, nodeIds, existing), []);
	});
});

describe("deriveLinks", () => {
	it("returns the created link with directed flag, origin and createdAt", () => {
		const links = deriveLinks([created("link_1", "n_a", "n_b", "sequence", "extractor")]);
		assert.deepEqual(links, [
			{ id: "link_1", from: "n_a", to: "n_b", linkType: "sequence", directed: true, origin: "extractor", createdAt: AT },
		]);
	});

	it("marks an undirected link as not directed", () => {
		assert.equal(deriveLinks([created("link_1", "n_a", "n_b", "analogy")])[0]?.directed, false);
	});

	it("removes a link when a removed event for its id follows", () => {
		const links = deriveLinks([
			created("link_1", "n_a", "n_b", "sequence"),
			{ type: "removed", id: "link_1", at: AT },
		]);
		assert.deepEqual(links, []);
	});

	it("ignores a removed event for an unknown id", () => {
		const links = deriveLinks([{ type: "removed", id: "link_9", at: AT }, created("link_1", "n_a", "n_b", "sequence")]);
		assert.deepEqual(links.map((l) => l.id), ["link_1"]);
	});

	it("ignores a created event whose id already exists (first one wins)", () => {
		const links = deriveLinks([created("link_1", "n_a", "n_b", "sequence"), created("link_1", "n_b", "n_c", "contrast")]);
		assert.deepEqual(links.map((l) => [l.from, l.to, l.linkType]), [["n_a", "n_b", "sequence"]]);
	});

	it("keeps creation order for surviving links", () => {
		const links = deriveLinks([
			created("link_1", "n_a", "n_b", "sequence"),
			created("link_2", "n_b", "n_c", "part-of"),
			created("link_3", "n_a", "n_c", "analogy"),
		]);
		assert.deepEqual(links.map((l) => l.id), ["link_1", "link_2", "link_3"]);
	});

	it("re-creating a removed id is accepted again", () => {
		const links = deriveLinks([
			created("link_1", "n_a", "n_b", "sequence"),
			{ type: "removed", id: "link_1", at: AT },
			created("link_1", "n_b", "n_c", "part-of"),
		]);
		assert.deepEqual(links.map((l) => [l.from, l.to]), [["n_b", "n_c"]]);
	});
});

describe("remapLinks", () => {
	it("rewrites from and to through the merge map and leaves other links alone", () => {
		const links = [link("link_1", "n_b", "n_c", "sequence"), link("link_2", "n_a", "n_c", "analogy")];
		const remapped = remapLinks(links, new Map([["n_b", "n_a"]]));
		assert.deepEqual(remapped, [link("link_1", "n_a", "n_c", "sequence"), link("link_2", "n_a", "n_c", "analogy")]);
	});

	it("drops a link that becomes a self-link", () => {
		const links = [link("link_1", "n_a", "n_b", "sequence")];
		assert.deepEqual(remapLinks(links, new Map([["n_b", "n_a"]])), []);
	});

	it("de-duplicates identical directed links after remapping, keeping the first", () => {
		const links = [link("link_1", "n_a", "n_c", "part-of"), link("link_2", "n_b", "n_c", "part-of")];
		const remapped = remapLinks(links, new Map([["n_b", "n_a"]]));
		assert.deepEqual(remapped.map((l) => l.id), ["link_1"]);
	});

	it("de-duplicates an undirected link whose reversed pair appears after remapping", () => {
		const links = [link("link_1", "n_a", "n_c", "contrast"), link("link_2", "n_c", "n_b", "contrast")];
		const remapped = remapLinks(links, new Map([["n_b", "n_a"]]));
		assert.deepEqual(remapped.map((l) => l.id), ["link_1"]);
	});

	it("does not de-duplicate a directed link with its reversed pair", () => {
		const links = [link("link_1", "n_a", "n_c", "sequence"), link("link_2", "n_c", "n_b", "sequence")];
		const remapped = remapLinks(links, new Map([["n_b", "n_a"]]));
		assert.deepEqual(remapped.map((l) => l.id), ["link_1", "link_2"]);
	});

	it("returns the input unchanged when the map is empty", () => {
		const links = [link("link_1", "n_a", "n_b", "sequence")];
		assert.deepEqual(remapLinks(links, new Map()), links);
	});
});
