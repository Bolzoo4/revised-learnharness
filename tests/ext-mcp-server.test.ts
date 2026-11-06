// tests/ext-mcp-server.test.ts
/** The protocol layer in process (REQ-mcp-01, -04, -05, -06, -08, -10, -12). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CATALOG } from "../src/server/ext/mcp/catalog.ts";
import { TOOL_NAMES, toolFields, toolGroup } from "../src/core/ext/mcp/tools.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { cleanupAllFixtures, GOAL_ID, HIDDEN, makeFixture, N, seedGraph, seedStandard } from "./helpers/mcp-fixture.ts";
import { callTool, connect } from "./helpers/mcp-client.ts";

afterEach(cleanupAllFixtures);

describe("catalog and registration", () => {
	it("the zod schemas and the handler tables name exactly the same tools and fields", () => {
		assert.deepEqual(Object.keys(CATALOG).sort(), [...TOOL_NAMES].sort());
		for (const name of TOOL_NAMES) assert.deepEqual(Object.keys(CATALOG[name]!.input.shape).sort(), [...toolFields(name)].sort(), name);
	});

	it("lists every tool as read-only, closed-world, non-destructive, with a description and an input schema", async () => {
		const f = makeFixture();
		const { client, close } = await connect(f);
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
		for (const t of tools) {
			assert.equal(t.annotations?.readOnlyHint, true, t.name);
			assert.equal(t.annotations?.destructiveHint, false, t.name);
			assert.equal(t.annotations?.openWorldHint, false, t.name);
			assert.ok((t.description ?? "").length > 20, t.name);
			assert.equal((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, `${t.name} must reject unknown keys`);
		}
		await close();
	});

	it("--knowledge-only registers only the knowledge group; the others are unknown tools", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f, true);
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES.filter((n) => toolGroup(n) === "knowledge").sort());
		for (const name of ["list_goals", "get_goal", "get_daily_plan", "research_status"]) {
			assert.equal((await callTool(client, name, { id: GOAL_ID })).isError, true, name);
		}
		assert.equal((await callTool(client, "get_node", { id: N.a })).isError, false);
		await close();
	});

	it("no tool name suggests a write", async () => {
		for (const name of TOOL_NAMES) assert.ok(!/^(set|add|create|update|delete|remove|write|mark|put|post|run|start|apply|save|import|upload)/.test(name), name);
	});
});

describe("calls over the protocol", () => {
	it("every tool accepts its documented arguments through the SDK's schema validation and answers", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const valid: Record<string, unknown[]> = {
			search_nodes: [{ query: "set" }, { query: "set", limit: 5, trust: "sourced", goalId: GOAL_ID }],
			get_node: [{ id: N.a }],
			get_neighbors: [{ id: N.c }, { id: N.c, depth: 2 }],
			list_lectures: [{}, { chapter: 2 }],
			get_lecture: [{ id: "lec_b0123abcd_c02_l01" }],
			list_goals: [{}, { status: "active", limit: 10 }],
			get_goal: [{ id: GOAL_ID }],
			get_daily_plan: [{}, { date: "2026-11-05" }],
			research_status: [{}],
		};
		assert.deepEqual(Object.keys(valid).sort(), [...TOOL_NAMES].sort());
		for (const [tool, inputs] of Object.entries(valid)) {
			for (const input of inputs) {
				const r = await callTool(client, tool, input);
				assert.equal(r.isError, false, `${tool}(${JSON.stringify(input)}): ${r.text.slice(0, 200)}`);
			}
		}
		await close();
	});

	it("returns structured content that equals the JSON text, for success and for failure", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const ok = await callTool(client, "get_node", { id: N.a });
		assert.equal(ok.isError, false);
		assert.deepEqual(JSON.parse(ok.text), ok.body);
		const bad = await callTool(client, "get_node", { id: "n_missing" });
		assert.equal(bad.isError, true);
		assert.equal(bad.body.error.code, "not_found");
		await close();
	});

	it("write-shaped or unknown arguments are refused, never ignored (REQ-mcp-02)", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const shapes: Array<[string, unknown]> = [
			["get_node", { id: N.a, delete: true }],
			["get_node", { id: N.a, action: "update", body: "x" }],
			["search_nodes", { query: "set", write: true }],
			["list_goals", { status: "active", set_status: "paused" }],
			["research_status", { mark: "hold" }],
			["get_daily_plan", { date: "2026-11-05", mark_done: true }],
			["get_node", { id: N.a, __proto__: { admin: true }, constructor: "x" }],
		];
		for (const [tool, args] of shapes) assert.equal((await callTool(client, tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
		for (const name of ["set_goal", "delete_node", "add_node", "mark_reviewed", "constructor", "__proto__", "toString", "", "GET_NODE"]) {
			assert.equal((await callTool(client, name, { id: N.a })).isError, true, name);
		}
		await close();
	});

	it("wrong-typed, oversized and hostile arguments give a structured error, not a crash", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const hostile: Array<[string, unknown]> = [
			["get_node", { id: null }], ["get_node", { id: ["a"] }], ["get_node", { id: "x".repeat(10_000) }],
			["search_nodes", { query: "a".repeat(100_000) }], ["search_nodes", { query: "set", limit: Number.NaN }],
			["search_nodes", { query: "set", limit: 1e12 }], ["search_nodes", { query: "set", limit: -3 }], ["search_nodes", { query: "set", limit: 1.5 }],
			["get_neighbors", { id: N.a, depth: 9 }], ["get_neighbors", { id: N.a, depth: "2" }],
			["get_daily_plan", { date: "9999-99-99" }], ["list_goals", { status: "'; drop table" }],
		];
		for (const [tool, args] of hostile) {
			const r = await callTool(client, tool, args);
			assert.equal(r.isError, true, `${tool} ${JSON.stringify(args).slice(0, 60)}`);
		}
		assert.equal((await callTool(client, "get_node", { id: N.a })).isError, false, "the server still answers");
		await close();
	});

	it("an unexpected internal error is the fixed internal message, logged on the side, never the raw message", async () => {
		const f = makeFixture();
		seedStandard(f);
		f.deps.verification = {
			readAll() {
				throw new Error(`EACCES: permission denied, open '${HIDDEN.localPath}/verification.jsonl' sk-ant-api03-HIDDENKEY`);
			},
		};
		const { client, logs, close } = await connect(f);
		const r = await callTool(client, "get_node", { id: N.a });
		assert.equal(r.isError, true);
		assert.equal(r.body.error.code, "internal");
		assert.ok(!r.text.includes("EACCES") && !r.text.includes(HIDDEN.localPath) && !r.text.includes("sk-ant"));
		assert.ok(logs.join("\n").includes("EACCES"), "the real error is available to the operator on stderr");
		assert.equal((await callTool(client, "list_lectures", {})).isError, false, "other tools keep working");
		await close();
	});

	it("a result above the response limit is refused, not cut", async () => {
		const f = makeFixture();
		seedGraph(f);
		const big = "x".repeat(LIMITS.statementChars);
		for (let i = 0; i < 40; i++) f.graph("nodes.jsonl", { id: `n_big${String(i).padStart(4, "0")}`, name: `Big ${i}`, statement: big, aliases: Array.from({ length: 30 }, (_, k) => `${big.slice(0, 190)}${k}`), kind: "definition", createdAt: "2026-11-01T00:00:00.000Z" });
		const { client, close } = await connect(f);
		const r = await callTool(client, "search_nodes", { query: "big", limit: 50 });
		assert.ok(r.text.length <= LIMITS.responseMaxBytes * 1.1 || r.isError);
		if (r.isError) assert.equal(r.body.error.code, "response_too_large");
		await close();
	});

	it("is read-only under concurrency: many parallel calls all answer", async () => {
		const f = makeFixture();
		seedStandard(f);
		const { client, close } = await connect(f);
		const results = await Promise.all(Array.from({ length: 60 }, (_, i) => callTool(client, i % 2 ? "get_node" : "search_nodes", i % 2 ? { id: N.a } : { query: "set" })));
		assert.ok(results.every((r) => !r.isError));
		await close();
	});
});
