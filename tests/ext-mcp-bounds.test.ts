// tests/ext-mcp-bounds.test.ts
/** REQ-mcp-08 at scale: every output of every tool stays bounded, paged and finite. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { TOOL_NAMES } from "../src/core/ext/mcp/tools.ts";
import fs from "node:fs";
import path from "node:path";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { chain, cleanupAllFixtures, makeFixture, node, type Fixture } from "./helpers/mcp-fixture.ts";
import { call, errorCode, type Json } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const LONG = "L".repeat(50_000);
const MAX_STRING = LIMITS.explanationChars + 100; // the longest field + its truncation marker

function bigFixture(): Fixture {
	const f = makeFixture();
	const alias = (i: number): string => `alias ${i} ${"a".repeat(500)}`;
	for (let i = 0; i < 1500; i++) {
		const id = `n_${String(i).padStart(8, "0")}`;
		f.graph("nodes.jsonl", node(id, `Set concept ${i} ${"N".repeat(400)}`, `${LONG} statement ${i}`, Array.from({ length: 40 }, (_, k) => alias(k))));
	}
	for (let i = 1; i < 1500; i++) {
		f.graph("chains.jsonl", chain(`ch_${i}`, [`n_${String(i - 1).padStart(8, "0")}`, `n_${String(Math.max(0, i - 2)).padStart(8, "0")}`, `n_00000000`], `n_${String(i).padStart(8, "0")}`));
	}
	for (let g = 0; g < 80; g++) {
		f.ext("goals.jsonl", { type: "created", goalId: `goal_${String(g).padStart(12, "0")}`, title: LONG, origin: "user", originRef: "", targetNodeIds: Array.from({ length: 60 }, (_, k) => `n_${String(k).padStart(8, "0")}`), priority: 3, at: "2026-11-01T00:00:00.000Z" });
	}
	for (let m = 0; m < 60; m++) {
		f.ext("frontier.jsonl", { type: "set", markId: `m${m}`, scope: { kind: "node", id: "n_00000000" }, mark: "hold", note: LONG, author: "agent", at: "2026-11-04T00:00:00.000Z" });
	}
	const base = makeLecture();
	const lecture = {
		...base,
		summary: LONG,
		title: LONG,
		slides: [...base.slides, ...Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, heading: LONG.slice(0, 20_000), elements: [{ id: `e${i}`, type: "text", content: `${LONG.slice(0, 20_000)} [[n_${String(i).padStart(8, "0")}]]` }] }))],
	};
	fs.mkdirSync(path.join(f.extDir, "lectures", lecture.id), { recursive: true });
	fs.writeFileSync(path.join(f.extDir, "lectures", lecture.id, "lecture.json"), JSON.stringify(lecture));
	for (let j = 0; j < 80; j++) {
		f.ext("journal.jsonl", { id: `deb_${String(j).padStart(12, "0")}`, kind: "session", sessionId: `s${j}`, sessionKind: "review", weekOf: null, at: "2026-11-01T10:00:00.000Z", facts: { kind: "review", blob: LONG }, commentary: LONG, nullReason: null, author: "agent" });
		f.ext("documents.jsonl", { type: "registered", documentId: j.toString(16).padStart(64, "0"), title: LONG, pageCount: 9, at: "2026-11-01T10:00:00.000Z" });
	}
	f.ext("explanations.jsonl", { type: "version", nodeId: "n_00000000", version: 1, body: LONG, author: "agent", sourceRefs: [], styleVersion: "abc123abc123", fingerprint: "x", noSource: false, proposed: false, at: "2026-11-02T11:00:00.000Z" });
	return f;
}

/** Every array in a result must be the `items` of a page-shaped object, or a short tuple of scalars; no non-finite number can be serialised. */
function walk(value: Json, where: string, strings: { max: number }): void {
	if (typeof value === "string") {
		strings.max = Math.max(strings.max, value.length);
		return;
	}
	if (typeof value === "number") {
		assert.ok(Number.isFinite(value), `${where}: non-finite number`);
		return;
	}
	if (Array.isArray(value)) {
		throw new Error(`${where}: a bare array escaped the Page wrapper`);
	}
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (k === "items") {
				assert.ok(Array.isArray(v), `${where}.items`);
				assert.equal(typeof value.count, "number", `${where}: items without count`);
				assert.equal(typeof value.truncated, "boolean", `${where}: items without truncated`);
				assert.equal(value.count, (v as Json[]).length, `${where}: count must equal the items returned`);
				assert.ok((v as Json[]).length <= 200, `${where}: page too long`);
				(v as Json[]).forEach((item, i) => walk(item, `${where}.items[${i}]`, strings));
			} else walk(v, `${where}.${k}`, strings);
		}
	}
}

describe("bounded outputs at scale (REQ-mcp-08)", () => {
	it("every tool answers within the response limit, with paged lists and capped strings", () => {
		const f = bigFixture();
		const cases: Array<[string, unknown]> = [
			["search_nodes", { query: "set concept", limit: 50 }], ["search_nodes", { query: "set concept" }],
			["get_node", { id: "n_00000000" }], ["get_node", { id: "n_00000700" }],
			["get_neighbors", { id: "n_00000700", depth: 2 }], ["get_neighbors", { id: "n_00000000", depth: 2 }],
			["list_lectures", {}], ["get_lecture", { id: makeLecture().id }], ["list_goals", { limit: 50 }], ["list_goals", {}], ["get_goal", { id: "goal_000000000000" }],
			["get_daily_plan", {}], ["research_status", {}], ["get_recent_debriefs", { limit: 50 }],
			["list_documents", {}],
		];
		for (const [tool, input] of cases) {
			const out = call(f, tool, input);
			const bytes = Buffer.byteLength(JSON.stringify(out), "utf-8");
			assert.ok(bytes <= LIMITS.responseMaxBytes, `${tool}: ${bytes} bytes`);
			const strings = { max: 0 };
			walk(out, tool, strings);
			assert.ok(strings.max <= MAX_STRING, `${tool}: a string of ${strings.max} characters`);
		}
		assert.equal(new Set(cases.map(([t]) => t)).size, TOOL_NAMES.length, "every tool is covered by this test");
	});

	it("truncation is explicit: the marker says how much was cut and a page says truncated", () => {
		const f = bigFixture();
		const node0 = call(f, "get_node", { id: "n_00000000" });
		assert.match(JSON.stringify(node0), /… \[truncated: \d+ more characters\]/);
		const r = call(f, "list_goals", { limit: 50 });
		assert.equal(r.count, 50);
		assert.equal(r.truncated, true);
		assert.equal(call(f, "research_status").frontier.truncated, true);
	});

	it("limits that are not positive integers fall back to the default; huge ones are capped", () => {
		const f = bigFixture();
		for (const limit of [Number.NaN, Infinity, -1, 0, 1.5, "10", null, 1e12]) {
			const r = call(f, "search_nodes", { query: "set concept", limit });
			assert.ok(r.count >= 1 && r.count <= LIMITS.listMax, `limit ${String(limit)} gave ${r.count}`);
		}
	});

	it("a long query is refused and a many-word query is bounded (no unbounded parsing time)", () => {
		const f = bigFixture();
		assert.equal(errorCode(f, "search_nodes", { query: "a".repeat(LIMITS.queryMaxChars + 1) }), "invalid_input");
		const started = performance.now();
		assert.equal(errorCode(f, "search_nodes", { query: Array.from({ length: 90 }, () => "a").join(" ") }), "invalid_input", "more than 8 words");
		assert.equal(call(f, "search_nodes", { query: "set concept alpha beta gamma delta epsilon zeta" }).truncated !== undefined, true);
		assert.ok(performance.now() - started < 5000, "the longest allowed query must stay fast");
	});

	it("depth-2 neighbourhoods of a hub node are capped in nodes and edges", () => {
		const f = bigFixture();
		const n = call(f, "get_neighbors", { id: "n_00000000", depth: 2 });
		assert.ok(n.nodes.items.length <= LIMITS.neighbourNodesMax);
		assert.ok(n.edges.items.length <= LIMITS.neighbourEdgesMax);
		assert.equal(n.nodes.truncated, true);
	});
});
