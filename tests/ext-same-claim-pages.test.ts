// tests/ext-same-claim-pages.test.ts
/**
 * REQ-graph-agent-26 (regression pin): the same claim found again on another page of one document is ONE node,
 * whose provenance keeps one entry per page. Real mergeFindings over the memory graph store; the identity verdict
 * is the auditor's link (the second submit links its proposition to the first node).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getGraph, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import type { SessionFindings } from "../src/core/contracts.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";

const NOW = "2026-11-22T10:00:00.000Z";
const SOURCE = "src_thesis";

function findingsOnPage(page: number, name: string, statement: string): SessionFindings {
	return { propositions: [{ id: "p1", name, statement, aliases: [], page }], chains: [] } as unknown as SessionFindings;
}

describe("the same claim on two pages of one document (REQ-graph-agent-26)", () => {
	it("one node, with a provenance entry for page 3 and one for page 7", () => {
		const graphStore = createMemoryGraphStore();
		const deps = { graphStore, chatStore: undefined as never } as GraphDeps;
		mergeFindings(SOURCE, findingsOnPage(3, "Dominated convergence", "If f_n is dominated, the integrals converge."), { links: [] }, deps, { foldedAt: NOW });
		const [first] = graphStore.readNodes();
		assert.ok(first);

		mergeFindings(
			SOURCE,
			findingsOnPage(7, "Dominated convergence again", "Under domination the integrals of f_n converge."),
			{ links: [{ id: "p1", linkTo: first!.id }] },
			deps,
			{ foldedAt: NOW },
		);

		const nodes = getGraph(graphStore).nodes;
		assert.equal(nodes.length, 1, "no second node is created (the derived graph merges the ledger lines by id)");
		const points = nodes[0]!.provenance.filter((p) => p.chatId === SOURCE).map((p) => p.page);
		assert.deepEqual(points.sort((a, b) => (a ?? 0) - (b ?? 0)), [3, 7]);
	});
});
