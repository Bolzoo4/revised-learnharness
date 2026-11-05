// tests/ext-verification-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import type { Verifier } from "../src/core/ext/ports.ts";
import type { SourceEntry } from "../src/core/ext/sources.ts";
import { createVerificationService } from "../src/core/ext/verification-service.ts";
import { activationTargets, postMergeTargets } from "../src/core/ext/verify-targets.ts";
import type { VerificationEvent } from "../src/core/ext/trust.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { fakeGate, memGoalsStore, memSnapshotStore, memSourcesStore, memVerificationStore, node } from "./helpers/ext-fakes.ts";

const created = (goalId: string, targets: string[]): GoalEvent => ({ type: "created", goalId, title: "G", origin: "user", originRef: "", targetNodeIds: targets, priority: 3, at: "t" });
const chain = (id: string, premises: string[], conclusion: string) => ({ id, premises, conclusion, provenance: [], createdAt: "t" });
const checked = (nodeId: string, outcome: "unverified" | "sourced" | "contested" | "refuted"): VerificationEvent => ({ type: "checked", nodeId, outcome, evidence: [], discarded: [], checker: "m", at: "t" });
const nodes = ["n1", "n2", "n3", "n4"].map((id) => node(id));

describe("trigger selection", () => {
	const goals = [{ id: "g", title: "G", origin: "user" as const, originRef: "", targetNodeIds: ["n1"], priority: 3, status: "active" as const, createdAt: "t", updatedAt: "t" }];
	const chains = [chain("c1", ["n2"], "n1")];

	it("post-merge: only in-scope nodes that were never attempted (REQ-ver-03)", () => {
		const out = postMergeTargets({ goals, nodes, chains, events: [checked("n2", "unverified")] });
		assert.deepEqual(out, ["n1"], "n2 was attempted, n3/n4 are out of scope");
	});
	it("post-merge: a failed attempt counts as attempted", () => {
		const out = postMergeTargets({ goals, nodes, chains, events: [{ type: "check_failed", nodeId: "n1", reason: "x", at: "t" }] });
		assert.deepEqual(out, ["n2"]);
	});
	it("post-merge: paused goals contribute nothing", () => {
		assert.deepEqual(postMergeTargets({ goals: [{ ...goals[0]!, status: "paused" }], nodes, chains, events: [] }), []);
	});
	it("activation: in-scope unverified and contested nodes, attempted or not, never sourced or refuted", () => {
		const events = [checked("n1", "sourced"), checked("n2", "contested")];
		assert.deepEqual(activationTargets({ goals, nodes, chains, events }), ["n2"]);
		assert.deepEqual(activationTargets({ goals, nodes, chains, events: [checked("n1", "unverified")] }).sort(), ["n1", "n2"]);
	});
	it("ignores scope ids that are no longer nodes", () => {
		assert.deepEqual(postMergeTargets({ goals, nodes: [node("n1")], chains, events: [] }), ["n1"]);
	});
});

function build(goalEvents: GoalEvent[], verifier: Verifier) {
	const graphStore = createMemoryGraphStore();
	for (const n of nodes) graphStore.appendNode(n);
	graphStore.appendChain(chain("c1", ["n2"], "n1"));
	const sourcesStore = memSourcesStore([{ id: "lib_p", kind: "url-prefix", locator: "https://x.org/", tier: "secondary", label: "X", status: "proposed", addedBy: "agent" }]);
	const verificationStore = memVerificationStore();
	const service = createVerificationService({
		graphStore, sourcesStore, snapshotStore: memSnapshotStore(), verificationStore, verifier,
		reader: { read: async () => null }, costGate: fakeGate(), goalsStore: memGoalsStore(goalEvents),
	});
	return { service, verificationStore, sourcesStore };
}

describe("verification service", () => {
	it("afterMerge verifies exactly the unattempted in-scope nodes", async () => {
		const seen: string[][] = [];
		const { service } = build([created("g", ["n1"])], { run: async (input) => (seen.push(input.nodes.map((n) => n.id)), { output: { results: [], proposedSources: [] }, checker: "m" }) });
		const report = await service.afterMerge();
		assert.deepEqual(seen, [["n1", "n2"]]);
		assert.deepEqual(report.checked.sort(), ["n1", "n2"]);
		assert.deepEqual((await service.afterMerge()).checked, [], "attempted nodes are not re-spent");
	});

	it("single-flight: a node already being verified is not started twice", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let runs = 0;
		const { service } = build([created("g", ["n1"])], { run: async () => { runs++; await gate; return { output: { results: [], proposedSources: [] }, checker: "m" }; } });
		const first = service.verify(["n3"]);
		const second = await service.verify(["n3"]);
		assert.deepEqual(second.checked, []);
		release();
		assert.deepEqual((await first).checked, ["n3"]);
		assert.equal(runs, 1);
	});

	it("on-demand verification works for any node, in scope or not", async () => {
		const { service, verificationStore } = build([], { run: async () => ({ output: { results: [], proposedSources: [] }, checker: "m" }) });
		await service.verify(["n4"]);
		assert.equal(verificationStore.events[0]?.nodeId, "n4");
	});

	it("activateSource activates the entry (user decision) and re-verifies in-scope unverified nodes", async () => {
		const seen: string[][] = [];
		const { service, sourcesStore } = build([created("g", ["n1"])], { run: async (input) => (seen.push(input.library.map((e) => e.id)), { output: { results: [], proposedSources: [] }, checker: "m" }) });
		const { entry, verification } = service.activateSource("lib_p", "primary");
		assert.equal(entry.status, "active");
		assert.equal(entry.tier, "primary");
		await verification;
		assert.deepEqual(seen, [["lib_p"]], "the activated entry is now visible to the verifier");
		assert.equal(sourcesStore.read()[0]!.status, "active");
	});

	it("trust() defaults to unverified and reflects the latest checked event", () => {
		const { service, verificationStore } = build([], { run: async () => ({ output: null, checker: "m" }) });
		verificationStore.appendEvent(checked("n1", "refuted"));
		const views = service.trust(["n1", "n2"]);
		assert.deepEqual(views.map((v) => [v.nodeId, v.level]), [["n1", "refuted"], ["n2", "unverified"]]);
		assert.equal(views[1]!.at, null);
	});
});
