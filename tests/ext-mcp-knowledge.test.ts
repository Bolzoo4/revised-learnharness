// tests/ext-mcp-knowledge.test.ts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanupAllFixtures, GOAL_ID, makeFixture, N, node, chain, seedGraph, seedStandard, HIDDEN } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

describe("search_nodes (REQ-mcp-04)", () => {
	it("finds by name, statement and alias, best match first, with trust", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "search_nodes", { query: "subset" });
		assert.equal(r.query, "subset");
		assert.deepEqual(r.items.map((i: { id: string }) => i.id).sort(), [N.a, N.b, N.c].sort()); // C by its alias "Subset order"
		assert.equal(r.count, r.items.length);
		assert.equal(r.truncated, false);
		const a = r.items.find((i: { id: string }) => i.id === N.a);
		assert.deepEqual(Object.keys(a).sort(), ["id", "name", "statement", "trust"]);
		assert.equal(a.trust, "sourced");
		assert.equal(call(f, "search_nodes", { query: "Axiom" }).items[0].id, N.a);
	});

	it("is deterministic: equal scores order by id", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_2", "same"), node("n_1", "same")], []);
		assert.deepEqual(call(f, "search_nodes", { query: "same" }).items.map((i: { id: string }) => i.id), ["n_1", "n_2"]);
	});

	it("bounds the list: default 20, maximum 50, truncated flag, invalid limits mean the default", () => {
		const f = makeFixture();
		seedGraph(f, Array.from({ length: 120 }, (_, i) => node(`n_${String(i).padStart(3, "0")}`, `thing ${i}`)), []);
		const d = call(f, "search_nodes", { query: "thing" });
		assert.equal(d.count, 20);
		assert.equal(d.truncated, true);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 1_000 }).count, 50);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 3 }).count, 3);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: Number.NaN }).count, 20);
		assert.equal(call(f, "search_nodes", { query: "thing", limit: 0 }).count, 20);
		assert.equal(call(f, "search_nodes", { query: "thing 11" }).count, 11 /* thing 11, 110-119 */);
	});

	it("filters by trust and by goal scope; a no-hit search is an empty page, not an error", () => {
		const f = makeFixture();
		seedStandard(f);
		assert.deepEqual(call(f, "search_nodes", { query: "set", trust: "sourced" }).items.map((i: { id: string }) => i.id), [N.a]);
		const inGoal = call(f, "search_nodes", { query: "node", goalId: GOAL_ID });
		assert.equal(inGoal.count, 0); // the loner is outside the goal's scope
		assert.ok(call(f, "search_nodes", { query: "set", goalId: GOAL_ID }).items.length >= 3);
		assert.deepEqual(call(f, "search_nodes", { query: "zzzz-nothing" }), { query: "zzzz-nothing", items: [], count: 0, truncated: false });
	});

	it("rejects bad input: empty or oversized queries, unknown trust, unknown goal", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const query of [undefined, "", "   ", 5, "x".repeat(201), "a b c d e f g h i"]) expectError(f, "search_nodes", { query }, "invalid_input");
		expectError(f, "search_nodes", { query: "set", trust: "maybe" }, "invalid_input");
		expectError(f, "search_nodes", { query: "set", goalId: "goal_unknown" }, "not_found");
		expectError(f, "search_nodes", { query: "set", goalId: "" }, "invalid_input");
	});

	it("goalId is refused under --knowledge-only", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "search_nodes", { query: "set", goalId: GOAL_ID }, "disabled", true);
		assert.ok(call(f, "search_nodes", { query: "set" }, true).count > 0);
	});

	it("a hostile query costs no more than a plain one (no regex, bounded tokens)", () => {
		const f = makeFixture();
		seedGraph(f, Array.from({ length: 3000 }, (_, i) => node(`n_${i}`, `name ${i}`, "x".repeat(300))), []);
		const started = Date.now();
		call(f, "search_nodes", { query: "(a+)+$ ".repeat(8).trim() });
		call(f, "search_nodes", { query: "a".repeat(200) });
		assert.ok(Date.now() - started < 3000, "search took too long");
	});

	it("duplicate node lines (link-appends) are one node whose phrasing becomes an alias", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_1", "Base", "first phrasing"), node("n_1", "Other name", "second phrasing")], []);
		const r = call(f, "search_nodes", { query: "second" });
		assert.deepEqual(r.items.map((i: { id: string }) => i.id), ["n_1"]);
		assert.equal(r.items[0].name, "Base");
	});
});

describe("get_node (REQ-mcp-04, REQ-mcp-09, REQ-mcp-10)", () => {
	it("returns statement, aliases, trust with evidence, explanation, arguments, lectures, cards, review, goals", () => {
		const f = makeFixture();
		seedStandard(f);
		const a = call(f, "get_node", { id: N.a });
		assert.equal(a.name, "Axiom A");
		assert.equal(a.trust.level, "sourced");
		assert.equal(a.trust.evidence.count, 1);
		assert.equal(a.trust.evidence.items[0].source, "lib_0000000a");
		assert.equal(a.cardCount, 1);
		assert.equal(a.studyState, "enabled");
		assert.ok(typeof a.review.dueAt === "string");
		assert.ok(a.review.recallProbability >= 0 && a.review.recallProbability <= 1);
		assert.equal(a.citingLectures.items[0].lectureId, "lec_b0123abcd_c02_l01");
		assert.deepEqual(a.conclusions.items.map((c: { id: string }) => c.id), [N.c]);
		assert.equal(a.goals.items[0].id, GOAL_ID);
		assert.equal(a.goals.items[0].isTarget, false);

		const c = call(f, "get_node", { id: N.c });
		assert.deepEqual(c.aliases.items, ["Subset order"]);
		assert.equal(c.arguments.count, 2, "two concluding chains = an alternative argument");
		assert.deepEqual(c.arguments.items.map((x: { premises: { count: number } }) => x.premises.count).sort(), [1, 2]);
		assert.equal(c.explanation.state, "current");
		assert.equal(c.explanation.noSourceContext, false);
		assert.match(c.explanation.body, /Follows from/);
		assert.equal(c.review, null);
	});

	it("marks a stale explanation and one written without source context", () => {
		const f = makeFixture();
		seedStandard(f);
		const d = call(f, "get_node", { id: N.d });
		assert.equal(d.explanation.state, "stale");
		assert.equal(d.explanation.noSourceContext, true);
		assert.equal(call(f, "get_node", { id: N.a }).explanation.state, "missing");
		assert.equal(call(f, "get_node", { id: N.a }).explanation.body, null);
	});

	it("never shows local paths, URL credentials, query strings, card answers or narration", () => {
		const f = makeFixture();
		seedStandard(f);
		const b = JSON.stringify(call(f, "get_node", { id: N.b }));
		assert.match(b, /algebra\.pdf/);
		assert.ok(!b.includes(HIDDEN.localPath));
		const a = JSON.stringify(call(f, "get_node", { id: N.a }));
		for (const secret of [HIDDEN.urlToken, HIDDEN.cardAnswer, "user:pw"]) assert.ok(!a.includes(secret), secret);
	});

	it("labels sources by library id, credential-free URL, or file name", () => {
		const f = makeFixture();
		seedStandard(f);
		f.ext("verification.jsonl", {
			type: "checked", nodeId: N.lone, outcome: "unverified", checker: "t:m", at: "2026-11-05T00:00:00.000Z", discarded: [],
			evidence: [
				{ sourceRef: `https://user:pw@example.org/p/q?token=${HIDDEN.urlToken}#f`, sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "example.org" },
				{ sourceRef: "file:///Users/x/y/book.pdf", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
				{ sourceRef: "C:\\Users\\x\\scan.pdf", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
				{ sourceRef: "/", sourceId: null, locator: "l", quote: "q".repeat(30), snapshot: "a".repeat(64), stance: "supports", tier: "unvetted", host: "" },
			],
		});
		const labels = call(f, "get_node", { id: N.lone }).trust.evidence.items.map((e: { source: string }) => e.source);
		assert.deepEqual(labels, ["https://example.org/p/q", "book.pdf", "scan.pdf", "local source"]);
	});

	it("caps long text with an explicit marker and bounds every nested list", () => {
		const f = makeFixture();
		const premises = Array.from({ length: 30 }, (_, i) => node(`n_p${i}`, `premise ${i}`));
		const nodes = [node("n_big", "Big", "s".repeat(5000), Array.from({ length: 40 }, (_, i) => `alias-${i}-${"z".repeat(300)}`)), ...premises];
		const chains = [chain("c1", premises.map((p) => p.id), "n_big"), ...Array.from({ length: 12 }, (_, i) => chain(`c_alt${i}`, [premises[i]!.id], "n_big"))];
		seedGraph(f, nodes, chains);
		const r = call(f, "get_node", { id: "n_big" });
		assert.match(r.statement, /\[truncated: \d+ more characters\]$/);
		assert.equal(r.aliases.count, 10);
		assert.equal(r.aliases.truncated, true);
		assert.match(r.aliases.items[0], /\[truncated/);
		assert.equal(r.arguments.count, 8);
		assert.equal(r.arguments.truncated, true);
		assert.equal(r.arguments.items[0].premises.count, 12);
		assert.equal(r.arguments.items[0].premises.truncated, true);
	});

	it("unknown, malformed and prototype-ish ids are a structured not-found or invalid-input, never a crash", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const id of ["n_missing", "__proto__", "constructor", "../../etc/passwd", "n_aaaa1111 "]) expectError(f, "get_node", { id }, "not_found");
		for (const id of [undefined, null, 5, "", "   ", "a\nb", "x".repeat(300)]) expectError(f, "get_node", { id }, "invalid_input");
	});

	it("--knowledge-only drops every learner-performance field", () => {
		const f = makeFixture();
		seedStandard(f);
		const a = call(f, "get_node", { id: N.a }, true);
		assert.equal(a.studyState, "disabled");
		for (const key of ["review", "cardCount", "goals", "reviewUnavailable"]) assert.equal(key in a, false, key);
		assert.equal(a.trust.level, "sourced");
	});

	it("a node in a cycle of chains still answers (cycle-safe)", () => {
		const f = makeFixture();
		seedGraph(f, [node("n_1", "One"), node("n_2", "Two")], [chain("c1", ["n_1"], "n_2"), chain("c2", ["n_2"], "n_1")]);
		assert.equal(call(f, "get_node", { id: "n_1" }).arguments.count, 1);
		assert.equal(call(f, "get_neighbors", { id: "n_1", depth: 2 }).nodes.count, 2);
	});

	it("a layered diamond graph does not blow up (bounded time)", () => {
		const f = makeFixture();
		const nodes = [] as ReturnType<typeof node>[];
		const chains = [] as ReturnType<typeof chain>[];
		for (let layer = 0; layer < 25; layer++) for (const side of ["l", "r"]) nodes.push(node(`n_${layer}${side}`, `n ${layer}${side}`));
		for (let layer = 1; layer < 25; layer++) for (const side of ["l", "r"]) chains.push(chain(`c${layer}${side}`, [`n_${layer - 1}l`, `n_${layer - 1}r`], `n_${layer}${side}`));
		seedGraph(f, nodes, chains);
		const started = Date.now();
		call(f, "get_node", { id: "n_24l" });
		assert.ok(Date.now() - started < 3000);
	});
});

describe("get_neighbors", () => {
	it("returns depth-1 or depth-2 neighbourhoods with names, trust and edges between included nodes", () => {
		const f = makeFixture();
		seedStandard(f);
		const one = call(f, "get_neighbors", { id: N.c });
		assert.equal(one.depth, 1);
		assert.equal(one.center.id, N.c);
		assert.deepEqual(one.nodes.items.map((n: { id: string }) => n.id), [N.c, N.a, N.b, N.d]);
		assert.deepEqual(one.nodes.items.map((n: { depth: number }) => n.depth), [0, 1, 1, 1]);
		assert.equal(one.edges.count, 3);
		const two = call(f, "get_neighbors", { id: N.d, depth: 2 });
		assert.deepEqual(two.nodes.items.map((n: { id: string }) => n.id), [N.d, N.c, N.a, N.b]);
		assert.equal(call(f, "get_neighbors", { id: N.lone }).nodes.count, 1);
	});

	it("rejects depth 0, 3, fractions and strings; unknown id is not-found", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const depth of [0, 3, 1.5, "1", null]) expectError(f, "get_neighbors", { id: N.a, depth }, "invalid_input");
		expectError(f, "get_neighbors", { id: "n_missing" }, "not_found");
	});

	it("bounds nodes and edges of a hub", () => {
		const f = makeFixture();
		const spokes = Array.from({ length: 200 }, (_, i) => node(`n_s${String(i).padStart(3, "0")}`, `s${i}`));
		seedGraph(f, [node("n_hub", "Hub"), ...spokes], spokes.map((s, i) => chain(`c${i}`, [s.id], "n_hub")));
		const r = call(f, "get_neighbors", { id: "n_hub", depth: 2 });
		assert.equal(r.nodes.count, 60);
		assert.equal(r.nodes.truncated, true);
		assert.equal(r.edges.count, 59);
		assert.equal(r.edges.truncated, false);
	});
});

describe("lectures (REQ-mcp-04)", () => {
	it("list_lectures gives the outline summary and can filter by chapter", () => {
		const f = makeFixture();
		seedStandard(f);
		const all = call(f, "list_lectures");
		assert.equal(all.count, 1);
		assert.deepEqual(all.items[0], {
			id: "lec_b0123abcd_c02_l01", title: "Sigma algebras", bookTitle: "Probability 1",
			chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 }, order: 1, createdAt: "2026-11-04T10:00:00.000Z",
			slideCount: 2, exerciseCount: 1, citedNodeCount: 2,
		});
		assert.equal(call(f, "list_lectures", { chapter: 2 }).count, 1);
		assert.equal(call(f, "list_lectures", { chapter: 3 }).count, 0);
		for (const chapter of [0, -1, 1.5, "2", null]) expectError(f, "list_lectures", { chapter }, "invalid_input");
	});

	it("get_lecture returns headings, node references and timed exercises, never the narration", () => {
		const f = makeFixture();
		seedStandard(f);
		const l = call(f, "get_lecture", { id: "lec_b0123abcd_c02_l01" });
		assert.deepEqual(l.slides.items.map((s: { heading: string }) => s.heading), ["Sigma algebra", "Looking ahead"]);
		assert.deepEqual(l.slides.items[0].nodeIds.items, [N.a]);
		assert.equal(l.exercises.items[0].seconds, 60);
		assert.match(l.exercises.items[0].prompt, /three element set/);
		assert.deepEqual(l.citedNodes.items.sort(), [N.a, N.b].sort());
		const text = JSON.stringify(l);
		assert.ok(!text.includes(HIDDEN.narration));
		assert.ok(!text.includes(HIDDEN.reveal));
	});

	it("get_lecture: malformed ids (including path traversal) are invalid input; an unknown id is not-found", () => {
		const f = makeFixture();
		seedStandard(f);
		for (const id of ["../../ext/goals", "lec_x", "..", "lec_b0123abcd_c02_l01/../../x", "", undefined, 5]) expectError(f, "get_lecture", { id }, "invalid_input");
		expectError(f, "get_lecture", { id: "lec_b0123abcd_c09_l09" }, "not_found");
	});
});
