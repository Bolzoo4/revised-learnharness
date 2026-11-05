// tests/ext-explanation-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveExplanations } from "../src/core/ext/explanations.ts";
import {
	decideProposal,
	generateExplanations,
	MAX_REGENERATIONS,
	saveUserExplanation,
	type ExplanationDeps,
} from "../src/core/ext/explanation-service.ts";
import {
	chain,
	closedGate,
	fakeWriter,
	graphWith,
	limitedGate,
	memoryExplanations,
	node,
	openGate,
	T0,
	type FakeWriter,
} from "./helpers/ext-node-fixtures.ts";

function setup(over: { writer?: FakeWriter; gate?: ExplanationDeps["cost"]; batchSize?: number } = {}) {
	const graph = graphWith([node("n_a"), node("n_b")], [chain("arg_1", ["n_a"], "n_b")]);
	const explanations = memoryExplanations();
	const writer = over.writer ?? fakeWriter((id) => `${id} is explained.`);
	const cost = over.gate ?? openGate();
	// read-only view of the graph: the service must not need any append method (REQ-int-02)
	const deps: ExplanationDeps = {
		graph: { readNodes: () => graph.readNodes(), readChains: () => graph.readChains() },
		explanations,
		writer,
		cost,
		now: () => T0,
		batchSize: over.batchSize,
	};
	return { graph, explanations, writer, cost, deps };
}

describe("generateExplanations", () => {
	it("writes one version per node, with fingerprint and no-source flag", async () => {
		const s = setup();
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_a", "n_b"]);
		assert.equal(s.writer.requests.length, 1);
		assert.equal(s.explanations.events.length, 2);
		const b = deriveExplanations(s.explanations.events).get("n_b")?.current;
		assert.equal(b?.version, 1);
		assert.equal(b?.fingerprint, "n_a");
		assert.equal(b?.noSource, true);
		assert.deepEqual(b?.sourceRefs, []);
		assert.equal(b?.author, "agent");
		assert.equal(b?.styleVersion, "style-test");
	});

	it("records the source references and clears no-source when a source is given (REQ-node-09)", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a"], source: { text: "chapter text", refs: ["h1"] } }, s.deps);
		const a = deriveExplanations(s.explanations.events).get("n_a")?.current;
		assert.equal(a?.noSource, false);
		assert.deepEqual(a?.sourceRefs, ["h1"]);
		assert.equal(s.writer.requests[0]?.source?.text, "chapter text");
	});

	it("gives the writer each node's arguments, users and form", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		const nodes = s.writer.requests[0]?.nodes ?? [];
		const b = nodes.find((n) => n.id === "n_b");
		assert.deepEqual(b?.arguments, [[{ id: "n_a", name: "n_a", statement: "n_a holds." }]]);
		assert.deepEqual(nodes.find((n) => n.id === "n_a")?.usedIn, [{ id: "n_b", name: "n_b" }]);
		assert.equal(b?.form, "short");
	});

	it("skips unknown nodes and nodes whose explanation is current", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		const again = await generateExplanations({ nodeIds: ["n_a", "n_zzz"], source: null }, s.deps);
		assert.deepEqual(again.skipped, [
			{ nodeId: "n_a", reason: "current" },
			{ nodeId: "n_zzz", reason: "unknown_node" },
		]);
		assert.equal(s.writer.requests.length, 1);
	});

	it("regenerates a stale agent explanation as a plain new version (REQ-node-03)", async () => {
		const s = setup();
		await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		s.graph.appendNode(node("n_c"));
		s.graph.appendChain(chain("arg_2", ["n_c"], "n_b"));
		const result = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_b"]);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.version, 2);
		assert.equal(b?.current?.fingerprint, "n_a|n_c");
	});

	it("never overwrites a user version: the agent text is a proposal (REQ-node-02)", async () => {
		const s = setup();
		s.explanations.appendEvent({
			type: "version", nodeId: "n_b", version: 1, body: "My own words.", author: "user",
			sourceRefs: [], styleVersion: "user", fingerprint: "", noSource: false, proposed: false, at: T0,
		});
		const result = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(result.proposed, ["n_b"]);
		assert.deepEqual(result.written, []);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.body, "My own words.");
		assert.equal(b?.proposal?.body, "n_b is explained.");
		// a second opening does not pay for the same proposal again
		const again = await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		assert.deepEqual(again.skipped, [{ nodeId: "n_b", reason: "pending_proposal" }]);
		assert.equal(s.writer.requests.length, 1);
	});

	it("rejects a text with an unresolved link, regenerates twice, then gives up (REQ-node-08)", async () => {
		const s = setup({ writer: fakeWriter(() => "See [[n_missing]].") });
		const result = await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		assert.equal(s.writer.requests.length, 1 + MAX_REGENERATIONS);
		assert.equal(MAX_REGENERATIONS, 2);
		assert.deepEqual(result.written, []);
		assert.equal(result.rejected[0]?.nodeId, "n_a");
		assert.match(result.rejected[0]?.errors[0] ?? "", /n_missing/);
		assert.equal(s.explanations.events.length, 0);
		assert.deepEqual(s.writer.requests[0]?.feedback, {});
		assert.match(s.writer.requests[1]?.feedback["n_a"]?.[0] ?? "", /n_missing/);
	});

	it("recovers when a regeneration is valid and only re-asks for the failed nodes", async () => {
		const s = setup({ writer: fakeWriter((id, attempt) => (id === "n_a" && attempt === 0 ? "See [[n_missing]]." : `${id} ok.`)) });
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(result.written, ["n_b", "n_a"]);
		assert.equal(s.writer.requests.length, 2);
		assert.deepEqual(s.writer.requests[1]?.nodes.map((n) => n.id), ["n_a"]);
	});

	it("does not call the writer at all when the cost ceiling is reached (REQ-node-05, REQ-node-16)", async () => {
		const gate = closedGate();
		const s = setup({ gate });
		const result = await generateExplanations({ nodeIds: ["n_a"], source: null }, s.deps);
		assert.equal(result.ceilingReached, true);
		assert.equal(s.writer.requests.length, 0);
		assert.equal(s.explanations.events.length, 0);
	});

	it("records every call's cost and stops mid-run when the ceiling closes", async () => {
		const gate = limitedGate(1);
		const s = setup({ gate, batchSize: 1 });
		const result = await generateExplanations({ nodeIds: ["n_a", "n_b"], source: null }, s.deps);
		assert.deepEqual(gate.spent, [0.01]);
		assert.equal(result.ceilingReached, true);
		assert.equal(result.written.length, 1);
	});

	it("sends one call per batch of neighbouring nodes (REQ-node-04)", async () => {
		const ids = ["n_a", "n_b", "n_c", "n_d", "n_e"];
		const graph = graphWith(ids.map((i) => node(i)), []);
		const explanations = memoryExplanations();
		const writer = fakeWriter((id) => `${id} ok.`);
		await generateExplanations(
			{ nodeIds: ids, source: null },
			{ graph, explanations, writer, cost: openGate(), now: () => T0, batchSize: 2 },
		);
		assert.deepEqual(writer.requests.map((r) => r.nodes.length), [2, 2, 1]);
	});
});

describe("saveUserExplanation (REQ-node-02)", () => {
	it("appends a non-proposed user version with the current fingerprint", () => {
		const s = setup();
		const saved = saveUserExplanation("n_b", "In my words, B follows from [[n_a]].", s.deps);
		assert.equal(saved.version, 1);
		const b = deriveExplanations(s.explanations.events).get("n_b")?.current;
		assert.equal(b?.author, "user");
		assert.equal(b?.fingerprint, "n_a");
	});

	it("refuses unresolved links, empty text and unknown nodes", () => {
		const s = setup();
		assert.throws(() => saveUserExplanation("n_b", "See [[n_missing]].", s.deps), /n_missing/);
		assert.throws(() => saveUserExplanation("n_b", "  ", s.deps), /empty/);
		assert.throws(() => saveUserExplanation("n_zzz", "Text.", s.deps), /unknown node/);
	});
});

describe("decideProposal", () => {
	async function withProposal() {
		const s = setup();
		saveUserExplanation("n_b", "Mine.", s.deps);
		// a new argument makes the user text stale, so the agent writes a proposal over it
		s.graph.appendNode(node("n_c"));
		s.graph.appendChain(chain("arg_2", ["n_c"], "n_b"));
		await generateExplanations({ nodeIds: ["n_b"], source: null }, s.deps);
		return s;
	}

	it("approving makes the proposal current", async () => {
		const s = await withProposal();
		decideProposal("n_b", "approved", s.deps);
		assert.equal(deriveExplanations(s.explanations.events).get("n_b")?.current?.body, "n_b is explained.");
	});

	it("rejecting keeps the user version and clears the proposal", async () => {
		const s = await withProposal();
		decideProposal("n_b", "rejected", s.deps);
		const b = deriveExplanations(s.explanations.events).get("n_b");
		assert.equal(b?.current?.body, "Mine.");
		assert.equal(b?.proposal, null);
	});

	it("refuses when no proposal is pending", () => {
		const s = setup();
		assert.throws(() => decideProposal("n_b", "approved", s.deps), /no pending proposal/);
	});
});
