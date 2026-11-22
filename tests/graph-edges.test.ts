// Graph view edges: chain arrows and typed links as one list (REQ-graph-agent-06).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edgesFor, legendFor } from "../src/core/ext/graph-edges.ts";
import type { Link } from "../src/core/ext/links.ts";
import { graphSnapshot } from "../src/core/graph.ts";
import type { GraphDeps } from "../src/core/graph.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";

const NODES = new Set(["a", "b", "c"]);

const link = (over: Pick<Link, "id" | "from" | "to" | "linkType"> & Partial<Link>): Link => ({
	directed: false,
	origin: "user",
	createdAt: "2026-11-22T00:00:00.000Z",
	...over,
});

describe("edgesFor", () => {
	it("chain edges keep the chain style and stay directed", () => {
		assert.deepEqual(edgesFor([{ from: "a", to: "b" }], [], NODES), [
			{ from: "a", to: "b", style: "chain", directed: true },
		]);
	});

	it("a link becomes a link:<type> edge carrying its directed flag", () => {
		const out = edgesFor(
			[],
			[
				link({ id: "l1", from: "a", to: "b", linkType: "evolution", directed: true }),
				link({ id: "l2", from: "b", to: "c", linkType: "analogy", directed: false }),
			],
			NODES,
		);
		assert.deepEqual(out, [
			{ from: "a", to: "b", style: "link:evolution", directed: true },
			{ from: "b", to: "c", style: "link:analogy", directed: false },
		]);
	});

	it("chain edges come first, then links, in one list", () => {
		const out = edgesFor(
			[{ from: "a", to: "b" }],
			[link({ id: "l1", from: "b", to: "c", linkType: "sequence", directed: true })],
			NODES,
		);
		assert.deepEqual(out.map((e) => e.style), ["chain", "link:sequence"]);
	});

	it("a link with an endpoint outside nodeIds is dropped (rollbacks can leave it dangling)", () => {
		const out = edgesFor(
			[],
			[
				link({ id: "l1", from: "a", to: "gone", linkType: "contrast" }),
				link({ id: "l2", from: "gone", to: "b", linkType: "contrast" }),
			],
			NODES,
		);
		assert.deepEqual(out, []);
	});
});

describe("legendFor", () => {
	it("lists only the link types present, in LINK_TYPES order", () => {
		const edges = edgesFor(
			[],
			[
				link({ id: "l1", from: "a", to: "b", linkType: "contrast" }),
				link({ id: "l2", from: "a", to: "c", linkType: "evolution", directed: true }),
			],
			NODES,
		);
		assert.deepEqual(legendFor(edges), ["evolution", "contrast"]);
	});

	it("chains alone give an empty legend", () => {
		assert.deepEqual(legendFor(edgesFor([{ from: "a", to: "b" }], [], NODES)), []);
	});
});

// ─── the payload: GET /api/graph carries `links`, dangling filtered ─────────

function node(id: string): GraphNode {
	return { id, name: id, statement: id, aliases: [], createdAt: "2026-11-22T00:00:00.000Z", provenance: [] };
}

function depsFor(nodes: GraphNode[]): GraphDeps {
	const graphStore = {
		readNodes: () => nodes,
		readChains: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
	} as unknown as GraphStore;
	const chatStore = {
		listChats: () => [],
		getChat: () => undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}

describe("graphSnapshot links", () => {
	it("carries links whose endpoints are both live propositions; dangling links drop", () => {
		const snap = graphSnapshot(depsFor([node("a"), node("b")]), {}, [
			link({ id: "keep", from: "a", to: "b", linkType: "sequence", directed: true }),
			link({ id: "dangling", from: "a", to: "gone", linkType: "analogy" }),
		]);
		assert.deepEqual(snap.links.map((l) => l.id), ["keep"]);
	});

	it("without a links argument the payload has an empty links list", () => {
		assert.deepEqual(graphSnapshot(depsFor([node("a")])).links, []);
	});
});
