// tests/ext-mcp-readonly.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import { parseGoalEvent } from "../src/core/ext/goals.ts";
import { createGoalsStore } from "../src/store/ext/goals-store.ts";
import { createLecturesStore } from "../src/store/ext/lectures-store.ts";
import { CURRENT_EXT_FORMAT_VERSION } from "../src/store/ext/format.ts";
import { createGraphReader, createLectureReader, createReadableGuard, EXT_FORMAT_VERSION, readOnlyLedger, validateDataRoot } from "../src/store/ext/readonly.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, node, seedStandard } from "./helpers/mcp-fixture.ts";

afterEach(cleanupAllFixtures);

const goal = (id: string, at = "2026-11-01T00:00:00.000Z") => ({
	type: "created", goalId: id, title: "t", origin: "user", originRef: "", targetNodeIds: [N.a], priority: 3, at,
});

describe("readOnlyLedger", () => {
	it("a missing file is empty; corrupt, torn and rejected lines are skipped", () => {
		const f = makeFixture();
		const ledger = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent);
		assert.deepEqual(ledger.readAll(), []);
		f.ext("goals.jsonl", goal("goal_000000000001"));
		f.ext("goals.jsonl", "{ not json");
		f.ext("goals.jsonl", { type: "created", goalId: "" }); // parser rejects
		f.ext("goals.jsonl", "");
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), '{"type":"created","goalId":"goal_0000000000'); // torn last line, no newline
		assert.equal(ledger.readAll().length, 1);
	});

	it("reads the same events as the app's createLedger (parity)", () => {
		const f = makeFixture();
		const store = createGoalsStore(f.extDir); // the app's writer
		store.appendEvent(goal("goal_000000000001") as never);
		store.appendEvent(goal("goal_000000000002") as never);
		fs.appendFileSync(path.join(f.extDir, "goals.jsonl"), "garbage\n");
		const mine = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent).readAll();
		assert.deepEqual(mine, store.readEvents());
	});

	it("a parser that throws on a line does not break the read", () => {
		const f = makeFixture();
		f.ext("x.jsonl", { a: 1 });
		f.ext("x.jsonl", { a: 2 });
		const ledger = readOnlyLedger(f.extDir, "x.jsonl", (raw) => {
			if ((raw as { a: number }).a === 1) throw new Error("boom");
			return raw;
		});
		assert.deepEqual(ledger.readAll(), [{ a: 2 }]);
	});

	it("refuses a file above the size ceiling with data_too_large (bounded parse time)", () => {
		const f = makeFixture();
		f.ext("goals.jsonl", goal("goal_000000000001"));
		const ledger = readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent, 10);
		assert.throws(() => ledger.readAll(), (e) => e instanceof ToolError && e.code === "data_too_large" && !/\/|\\/.test(e.message));
	});

	it("exposes no write method", () => {
		const f = makeFixture();
		assert.deepEqual(Object.keys(readOnlyLedger(f.extDir, "goals.jsonl", parseGoalEvent)), ["readAll"]);
	});
});

describe("format stamps (REQ-mcp-03)", () => {
	it("the constant equals the app's", () => {
		assert.equal(EXT_FORMAT_VERSION, CURRENT_EXT_FORMAT_VERSION);
	});

	it("no stamp, version 1, a corrupt stamp and a non-integer stamp are readable", () => {
		const f = makeFixture();
		const guard = createReadableGuard(f.root);
		guard();
		f.writeStamp("ext", 1);
		f.writeStamp("graph", 1);
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), "{ corrupt");
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), '{"version": 2.5}');
		guard();
		fs.writeFileSync(path.join(f.extDir, "format.json"), "null");
		guard();
	});

	it("a newer ext stamp or a newer graph stamp refuses with a fixed message", () => {
		for (const dir of ["ext", "graph"] as const) {
			const f = makeFixture();
			f.writeStamp(dir, 2);
			assert.throws(() => createReadableGuard(f.root)(), (e) => e instanceof ToolError && e.code === "data_newer_than_build" && !e.message.includes(f.root));
		}
	});
});

describe("validateDataRoot", () => {
	it("accepts a directory, refuses a missing path and a file, and never creates anything", () => {
		const f = makeFixture();
		validateDataRoot(f.root);
		const missing = path.join(f.root, "nope");
		assert.throws(() => validateDataRoot(missing), /data directory not found/);
		assert.equal(fs.existsSync(missing), false);
		const file = path.join(f.root, "afile");
		fs.writeFileSync(file, "x");
		assert.throws(() => validateDataRoot(file), /data directory not found/);
	});
});

describe("graph reader", () => {
	it("skips corrupt and ill-shaped lines and keeps order", () => {
		const f = makeFixture();
		f.graph("nodes.jsonl", node("n_1", "One"));
		f.graph("nodes.jsonl", "{ torn");
		f.graph("nodes.jsonl", { id: "n_bad", name: 5 });
		f.graph("nodes.jsonl", node("n_2", "Two"));
		f.graph("chains.jsonl", { id: "c", premises: [], conclusion: "n_1", provenance: [], createdAt: "x" }); // no premises
		f.graph("chains.jsonl", { id: "c2", premises: ["n_1"], conclusion: "n_2", provenance: [], createdAt: "x" });
		const reader = createGraphReader(f.graphDir);
		assert.deepEqual(reader.readNodes().map((n) => n.id), ["n_1", "n_2"]);
		assert.deepEqual(reader.readChains().map((c) => c.id), ["c2"]);
	});

	it("matches upstream's graphStore on the same files, and importing upstream deletes legacy ledgers (why we do not)", () => {
		const f = makeFixture();
		seedStandard(f);
		f.graph("nodes.jsonl", "garbage");
		f.graph("nodes.jsonl", { id: "n_x", name: "x" });
		const legacy = path.join(f.graphDir, "edges.jsonl");
		fs.writeFileSync(legacy, "legacy\n");
		const script = `
			import { graphStore } from "./src/store/graph.ts";
			process.stdout.write(JSON.stringify({ nodes: graphStore.readNodes(), chains: graphStore.readChains() }));
		`;
		const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: path.resolve(import.meta.dirname, ".."),
			env: { ...process.env, LH_DATA_DIR: f.root, NODE_ENV: "test" },
			encoding: "utf-8",
		});
		const upstream = JSON.parse(out.slice(out.indexOf("{"))) as { nodes: unknown[]; chains: unknown[] };
		const mine = createGraphReader(f.graphDir);
		assert.deepEqual(mine.readNodes(), upstream.nodes);
		assert.deepEqual(mine.readChains(), upstream.chains);
		assert.equal(fs.existsSync(legacy), false, "importing store/graph.ts purged edges.jsonl: the server must never import it");
	});
});

describe("lecture reader", () => {
	it("reads what the app's store writes, skips junk, and ignores a file under another id", () => {
		const f = makeFixture();
		const store = createLecturesStore(f.extDir);
		const a = makeLecture();
		const b = makeLecture({ id: "lec_b0123abcd_c02_l02", order: 2, title: "Second" });
		store.save(a);
		store.save(b);
		const reader = createLectureReader(f.extDir);
		assert.deepEqual(reader.list(), store.list()); // parity with the app's reader on clean data
		fs.mkdirSync(path.join(f.extDir, "lectures", "not-a-lecture-id"), { recursive: true });
		fs.mkdirSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l03"), { recursive: true });
		fs.writeFileSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l03", "lecture.json"), JSON.stringify({ ...a, id: "lec_b0123abcd_c02_l01" })); // wrong dir
		fs.mkdirSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l04"), { recursive: true });
		fs.writeFileSync(path.join(f.extDir, "lectures", "lec_b0123abcd_c02_l04", "lecture.json"), "{ corrupt");
		// The app's store would list the wrong-directory file as a duplicate of l01; the server does not.
		assert.deepEqual(reader.list().map((l) => l.id), [a.id, b.id]);
		assert.equal(reader.get("lec_b0123abcd_c02_l03"), null);
		assert.equal(reader.get("../../etc/passwd"), null);
		assert.equal(reader.get("lec_b0123abcd_c02_l99"), null);
	});
});

void GOAL_ID;
