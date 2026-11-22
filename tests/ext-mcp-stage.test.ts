// tests/ext-mcp-stage.test.ts
/**
 * Stage on the read-only MCP tools (REQ-graph-agent-09, -15): search_nodes filters
 * by stage before the limit, get_node reports the stage, list_goals and get_goal
 * count the stages of their scope. The fixtures are real ledger files, read by the
 * server's own readers.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runTool } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, makeFixture, node, type Fixture } from "./helpers/mcp-fixture.ts";

afterEach(cleanupAllFixtures);

const AT = "2026-11-01T00:00:00.000Z";
const STAGED_IDS = Array.from({ length: 12 }, (_, i) => `n_staged${String(i).padStart(2, "0")}`);
const CONFIRMED_IDS = ["n_confirmed_a", "n_confirmed_b"];

const call = (f: Fixture, name: string, input: Record<string, unknown> = {}, knowledgeOnly = false) => runTool(name, f.deps, input, { knowledgeOnly }) as any;

/** Twelve nodes in an active goal's scope (never taught, so staged) and two nodes outside every goal (confirmed). */
function stagedFixture(): Fixture {
	const f = makeFixture();
	STAGED_IDS.forEach((id, i) => f.graph("nodes.jsonl", node(id, `Concept staged ${i}`)));
	CONFIRMED_IDS.forEach((id) => f.graph("nodes.jsonl", node(id, `Concept confirmed ${id.slice(-1)}`)));
	f.ext("goals.jsonl", { type: "created", goalId: "goal_stage000001", title: "Stage goal", origin: "user", originRef: "", targetNodeIds: STAGED_IDS, priority: 3, at: AT });
	return f;
}

describe("search_nodes stage filter (REQ-graph-agent-09)", () => {
	it("the default filter is confirmed: only the nodes outside every goal are returned", () => {
		const out = call(stagedFixture(), "search_nodes", { query: "concept" });
		assert.deepEqual(out.items.map((i: { id: string }) => i.id).sort(), [...CONFIRMED_IDS].sort());
		assert.ok(out.items.every((i: { stage: string }) => i.stage === "confirmed"));
		assert.equal(out.truncated, false);
	});

	it("a graph with no goals and no review history has every node confirmed, so the default returns them all", () => {
		const f = makeFixture();
		for (let i = 0; i < 3; i += 1) f.graph("nodes.jsonl", node(`n_plain${i}`, `Plain concept ${i}`));
		const out = call(f, "search_nodes", { query: "plain" });
		assert.equal(out.count, 3);
		assert.ok(out.items.every((i: { stage: string }) => i.stage === "confirmed"));
	});

	it("filters before the limit: staged with limit 5 returns 5 staged nodes and says more exist", () => {
		const out = call(stagedFixture(), "search_nodes", { query: "concept", stage: "staged", limit: 5 });
		assert.equal(out.count, 5);
		assert.equal(out.truncated, true);
		assert.ok(out.items.every((i: { stage: string }) => i.stage === "staged"));
	});

	it("stage all returns every node and carries the stage of each hit", () => {
		const out = call(stagedFixture(), "search_nodes", { query: "concept", stage: "all", limit: 50 });
		assert.equal(out.count, 14);
		const stages = new Map(out.items.map((i: { id: string; stage: string }) => [i.id, i.stage]));
		assert.equal(stages.get(STAGED_IDS[0]), "staged");
		assert.equal(stages.get(CONFIRMED_IDS[0]), "confirmed");
	});

	it("an unknown stage is refused", () => {
		assert.throws(() => call(stagedFixture(), "search_nodes", { query: "concept", stage: "bogus" }), (e: any) => e.code === "invalid_input");
	});
});

describe("get_node stage (REQ-graph-agent-09)", () => {
	it("returns the stage of the node", () => {
		const f = stagedFixture();
		assert.equal(call(f, "get_node", { id: STAGED_IDS[0] }).stage, "staged");
		assert.equal(call(f, "get_node", { id: CONFIRMED_IDS[0] }).stage, "confirmed");
	});

	it("is null under --knowledge-only, where the stage would depend on study state", () => {
		assert.equal(call(stagedFixture(), "get_node", { id: STAGED_IDS[0] }, true).stage, null);
	});
});

describe("list_goals and get_goal stage counts (REQ-graph-agent-15)", () => {
	it("list_goals counts the stages of each goal's scope", () => {
		const row = call(stagedFixture(), "list_goals", {}).items[0];
		assert.deepEqual(row.stages, { staged: 12, unrevised: 0, confirmed: 0 });
	});

	it("get_goal counts the stages of its scope", () => {
		assert.deepEqual(call(stagedFixture(), "get_goal", { id: "goal_stage000001" }).stages, { staged: 12, unrevised: 0, confirmed: 0 });
	});
});

describe("search_nodes under --knowledge-only", () => {
	it("returns every node by default, with a null stage, because stages need study state", () => {
		const out = call(stagedFixture(), "search_nodes", { query: "concept" }, true);
		assert.equal(out.count, 14);
		assert.ok(out.items.every((i: { stage: unknown }) => i.stage === null));
	});

	it("refuses an explicit stage filter", () => {
		assert.throws(() => call(stagedFixture(), "search_nodes", { query: "concept", stage: "staged" }, true), (e: any) => e.code === "disabled");
	});
});
