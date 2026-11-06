// tests/ext-mcp-immutable.test.ts
/**
 * REQ-mcp-02 (adversarial): after EVERY tool call, in every data state, the
 * data directory is byte-for-byte unchanged: contents, sizes, mtimes (files AND
 * directories), inodes; no new file, no format.json stamp, no lock or temp
 * file. A tripwire also makes every fs write API throw during the call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, seedGraph, seedStandard, type Fixture } from "./helpers/mcp-fixture.ts";
import { fsTripwire, treeDigest } from "./helpers/mcp-dir-hash.ts";
import { errorCode } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const INPUTS: Record<string, unknown[]> = {
	search_nodes: [{ query: "set" }, { query: "zzz" }, { query: "" }, { query: 7 }],
	get_node: [{ id: N.a }, { id: N.d }, { id: "n_missing" }, {}],
	get_neighbors: [{ id: N.c, depth: 2 }, { id: "n_missing" }],
	list_lectures: [{}, { chapter: "x" }],
	get_lecture: [{ id: "lec_missing" }, { id: "../../etc/passwd" }],
	list_goals: [{}, { status: "active" }],
	get_goal: [{ id: GOAL_ID }, { id: "goal_nope" }],
	get_daily_plan: [{}, { date: "2026-11-05" }, { date: "nope" }],
	research_status: [{}, { extra: 1 }],
};

function exercise(f: Fixture, label: string, knowledgeOnly: boolean): void {
	const before = treeDigest(f.root);
	const files = fs.readdirSync(f.root, { recursive: true }).map(String).sort();
	for (const tool of TOOL_NAMES) {
		for (const input of INPUTS[tool] ?? [{}]) {
			const trip = fsTripwire();
			try {
				errorCode(f, tool, input, knowledgeOnly);
			} finally {
				trip.restore();
			}
			assert.deepEqual(trip.calls, [], `${label}: ${tool} called a write API`);
			assert.equal(treeDigest(f.root), before, `${label}: ${tool}(${JSON.stringify(input)}) changed the data directory`);
		}
	}
	assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).map(String).sort(), files, `${label}: files appeared or vanished`);
}

describe("the data directory is untouched by every tool (REQ-mcp-02)", () => {
	it("full data, all tools", () => exercise(seedAndReturn(), "full", false));
	it("full data, knowledge-only", () => exercise(seedAndReturn(), "knowledge-only", true));

	it("data without any format.json: no stamp is written", () => {
		const f = seedAndReturn();
		for (const dir of [f.extDir, f.graphDir]) assert.ok(!fs.existsSync(path.join(dir, "format.json")));
		exercise(f, "unstamped", false);
		for (const dir of [f.extDir, f.graphDir]) assert.ok(!fs.existsSync(path.join(dir, "format.json")));
	});

	it("data with a stamp at the current version stays byte-identical", () => {
		const f = seedAndReturn();
		f.writeStamp("ext", 1);
		f.writeStamp("graph", 1);
		exercise(f, "stamped", false);
	});

	it("an empty data directory (no ext, no graph) is not populated", () => {
		const f = makeFixture();
		fs.rmSync(f.extDir, { recursive: true, force: true });
		fs.rmSync(f.graphDir, { recursive: true, force: true });
		exercise(f, "empty", false);
		assert.deepEqual(fs.readdirSync(f.root), []);
	});

	it("data with corrupt and torn lines is not repaired", () => {
		const f = seedAndReturn();
		fs.appendFileSync(path.join(f.extDir, "review.jsonl"), '{"type":"review","nodeId":"n_aa');
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), "not json at all\n");
		exercise(f, "corrupt", false);
	});

	it("a newer stamp refuses every call and still changes nothing", () => {
		const f = seedAndReturn();
		f.writeStamp("ext", 99);
		const before = treeDigest(f.root);
		for (const tool of TOOL_NAMES) assert.equal(errorCode(f, tool, tool === "get_node" ? { id: N.a } : {}), "data_newer_than_build", tool);
		assert.equal(treeDigest(f.root), before);
	});

	it("the oracle detects a one-byte change, a new empty file and a touched mtime (it is not blind)", () => {
		const f = seedAndReturn();
		const base = treeDigest(f.root);
		const goals = path.join(f.extDir, "goals.jsonl");
		const original = fs.readFileSync(goals);
		fs.writeFileSync(path.join(f.root, "x.lock"), "");
		assert.notEqual(treeDigest(f.root), base, "new empty file");
		fs.rmSync(path.join(f.root, "x.lock"));
		const st = fs.statSync(goals);
		fs.utimesSync(goals, st.atime, new Date(st.mtimeMs + 5000));
		assert.notEqual(treeDigest(f.root), base, "touched mtime");
		fs.writeFileSync(goals, Buffer.concat([original, Buffer.from(" ")]));
		assert.notEqual(treeDigest(f.root), base, "one byte");
	});

	it("the tripwire is live: a write during a call is caught", () => {
		const f = seedAndReturn();
		const trip = fsTripwire();
		try {
			assert.throws(() => fs.writeFileSync(path.join(f.root, "boom"), "x"));
		} finally {
			trip.restore();
		}
		assert.deepEqual(trip.calls, ["writeFileSync"]);
		assert.ok(!fs.existsSync(path.join(f.root, "boom")));
	});
});

function seedAndReturn(): Fixture {
	const f = makeFixture();
	seedStandard(f);
	return f;
}
void seedGraph;
