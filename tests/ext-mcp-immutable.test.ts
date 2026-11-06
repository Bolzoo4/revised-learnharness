// tests/ext-mcp-immutable.test.ts
/**
 * REQ-mcp-02 (adversarial): after EVERY tool call, in every data state, the
 * data directory is byte-for-byte unchanged: contents, sizes, mtimes (files AND
 * directories), inodes; no new file, no format.json stamp, no lock or temp
 * file. A tripwire also makes every fs write API throw during the call. The
 * inputs include VALID ids on populated data, so the tools read real records
 * (not only the not-found and invalid paths).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { debriefId } from "../src/core/ext/debrief/journal.ts";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, seedStandard, type Fixture } from "./helpers/mcp-fixture.ts";
import { fsTripwire, treeDigest } from "./helpers/mcp-dir-hash.ts";
import { errorCode } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const LECTURE_ID = makeLecture().id;
const DOC_ID = "a".repeat(64);

const INPUTS: Record<string, unknown[]> = {
	search_nodes: [{ query: "set" }, { query: "zzz" }, { query: "" }, { query: 7 }, { query: "set", goalId: GOAL_ID }],
	get_node: [{ id: N.a }, { id: N.d }, { id: N.c }, { id: "n_missing" }, {}],
	get_neighbors: [{ id: N.c, depth: 2 }, { id: N.a, depth: 1 }, { id: "n_missing" }],
	list_lectures: [{}, { chapter: 2 }, { chapter: "x" }],
	get_lecture: [{ id: LECTURE_ID }, { id: "lec_missing" }, { id: "../../etc/passwd" }],
	list_goals: [{}, { status: "active" }],
	get_goal: [{ id: GOAL_ID }, { id: "goal_nope" }],
	get_daily_plan: [{}, { date: "2026-11-05" }, { date: "nope" }],
	research_status: [{}, { extra: 1 }],
	get_recent_debriefs: [{}, { limit: 5 }, { kind: "review" }, { since: "2026-11-01T00:00:00Z" }],
	list_documents: [{}],
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

/** Journal and document records, so get_recent_debriefs and list_documents read real data. */
function seedDebriefsAndDocuments(f: Fixture): void {
	f.ext("journal.jsonl", {
		id: debriefId("s1"), kind: "session", sessionId: "s1", sessionKind: "review", weekOf: null, at: "2026-11-02T10:00:00.000Z",
		facts: { kind: "review", cards: 3 }, commentary: "Good session.", nullReason: null, author: "agent",
	});
	f.ext("journal.jsonl", {
		id: debriefId("weekly:2026-11-02"), kind: "weekly", sessionId: null, sessionKind: null, weekOf: "2026-11-02", at: "2026-11-04T08:00:00.000Z",
		facts: { kind: "weekly", sessions: 1 }, commentary: "Weekly text.", nullReason: null, author: "agent",
	});
	f.ext("documents.jsonl", { type: "registered", documentId: DOC_ID, title: "Probability", pageCount: 10, at: "2026-11-01T10:00:00.000Z" });
	f.ext("reading.jsonl", { type: "visit", documentId: DOC_ID, page: 2, at: "2026-11-03T10:00:00.000Z" });
}

function seedAndReturn(): Fixture {
	const f = makeFixture();
	seedStandard(f);
	seedDebriefsAndDocuments(f);
	return f;
}

describe("the data directory is untouched by every tool (REQ-mcp-02)", () => {
	it("full data, all tools", () => exercise(seedAndReturn(), "full", false));
	it("full data, knowledge-only", () => exercise(seedAndReturn(), "knowledge-only", true));

	it("the valid-id inputs really read records (the oracle is not exercising only empty answers)", () => {
		const f = seedAndReturn();
		assert.equal(errorCode(f, "get_lecture", { id: LECTURE_ID }), "none");
		assert.equal(errorCode(f, "get_recent_debriefs", {}), "none");
		assert.equal(errorCode(f, "list_documents", {}), "none");
		assert.equal(errorCode(f, "get_goal", { id: GOAL_ID }), "none");
		assert.equal(errorCode(f, "search_nodes", { query: "set", goalId: GOAL_ID }), "none");
	});

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

	it("the tripwire is live for sync, callback and promise write forms, and reads still pass", async () => {
		const f = seedAndReturn();
		const target = path.join(f.root, "boom");
		const trip = fsTripwire();
		try {
			assert.throws(() => fs.writeFileSync(target, "x"));
			assert.throws(() => fs.writeFile(target, "x", () => undefined));
			assert.throws(() => fs.mkdir(path.join(f.root, "d"), () => undefined));
			await assert.rejects(fs.promises.writeFile(target, "x"));
			assert.throws(() => fs.openSync(target, "w"));
			assert.throws(() => fs.createWriteStream(target));
			assert.ok(fs.readFileSync(path.join(f.extDir, "goals.jsonl")).length > 0, "a read still works while the tripwire is armed");
		} finally {
			trip.restore();
		}
		assert.deepEqual(trip.calls, ["writeFileSync", "writeFile", "mkdir", "promises.writeFile", "openSync", "createWriteStream"]);
		assert.ok(!fs.existsSync(target));
		assert.ok(!fs.existsSync(path.join(f.root, "d")));
	});
});
