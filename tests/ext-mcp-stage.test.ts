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
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHTS } from "../src/core/ext/goals.ts";
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

	it("stage all returns every node and computes no stage (stage is null on each hit)", () => {
		const out = call(stagedFixture(), "search_nodes", { query: "concept", stage: "all", limit: 50 });
		assert.equal(out.count, 14);
		assert.ok(out.items.every((i: { stage: unknown }) => i.stage === null));
	});

	it("stage all never replays the review history: a broken review ledger still answers, the default does not", () => {
		const f = stagedFixture();
		const broken = { ...f.deps, review: { ...f.deps.review, reviewStore: { ...f.deps.review.reviewStore, readEvents: () => { throw new Error("replay boom"); } } } };
		const all = runTool("search_nodes", broken, { query: "concept", stage: "all" }, { knowledgeOnly: false }) as any;
		assert.equal(all.count, 14);
		assert.throws(() => runTool("search_nodes", broken, { query: "concept" }, { knowledgeOnly: false }), (e: any) => e.code === "data_inconsistent");
	});

	it("hiddenByStage says how many text matches the stage filter hid", () => {
		const f = stagedFixture();
		assert.equal(call(f, "search_nodes", { query: "concept" }).hiddenByStage, 12);
		assert.equal(call(f, "search_nodes", { query: "concept", stage: "staged", limit: 5 }).hiddenByStage, 2);
		assert.equal(call(f, "search_nodes", { query: "concept", stage: "all" }).hiddenByStage, 0);
	});

	it("goalId keeps a node reached only by a link at weight 1, and drops it at weight 0", () => {
		const build = (analogy: number) => {
			const f = makeFixture();
			f.graph("nodes.jsonl", node("n_target", "Concept target"));
			f.graph("nodes.jsonl", node("n_linked", "Concept linked"));
			f.ext("goals.jsonl", { type: "created", goalId: "goal_link000001", title: "Link goal", origin: "user", originRef: "", targetNodeIds: ["n_target"], priority: 3, weights: { ...DEFAULT_WEIGHTS, analogy }, at: AT });
			f.ext("links.jsonl", { type: "created", id: "lk_1", from: "n_target", to: "n_linked", linkType: "analogy", origin: "user", at: AT });
			return f;
		};
		const at1 = call(build(1), "search_nodes", { query: "concept", goalId: "goal_link000001", stage: "all" });
		assert.deepEqual(at1.items.map((i: { id: string }) => i.id).sort(), ["n_linked", "n_target"]);
		const at0 = call(build(0), "search_nodes", { query: "concept", goalId: "goal_link000001", stage: "all" });
		assert.deepEqual(at0.items.map((i: { id: string }) => i.id), ["n_target"]);
	});

	it("get_node gives each provenance point the label of its source file (a name, never a path); a chat point gets null", () => {
		const f = makeFixture();
		f.graph("nodes.jsonl", { ...node("n_prov", "Provenance node"), provenance: [{ chatId: "src_book", messageId: "m1", page: 3, passage: null }, { chatId: "chat_abc", messageId: "m2" }] });
		fs.writeFileSync(path.join(f.graphDir, "sources.json"), JSON.stringify({ src_book: { id: "src_book", filePath: "/Users/someone/Private/Bio/notes.pdf", importedAt: AT } }));
		const out = call(f, "get_node", { id: "n_prov" });
		assert.equal(out.provenance.items[0].sourceLabel, "notes.pdf");
		assert.equal(out.provenance.items[1].sourceLabel, null);
		assert.ok(!JSON.stringify(out).includes("/Users/"));
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
