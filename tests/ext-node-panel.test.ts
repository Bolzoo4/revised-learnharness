// tests/ext-node-panel.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExplanationEvent } from "../src/core/ext/explanations.ts";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import { buildNodePanel, type PanelInput } from "../src/core/ext/node-panel.ts";
import { chain, graphWith, node, T0 } from "./helpers/ext-node-fixtures.ts";

// n_e -> n_a ; (n_a, n_b) -> n_c ; n_a -> n_c (alternative) ; n_c -> n_d
const graph = graphWith(
	["n_a", "n_b", "n_c", "n_d", "n_e"].map((i) => node(i, i.toUpperCase())),
	[
		chain("arg_1", ["n_a", "n_b"], "n_c"),
		chain("arg_2", ["n_a"], "n_c"),
		chain("arg_3", ["n_c"], "n_d"),
		chain("arg_4", ["n_e"], "n_a"),
	],
);

const version = (nodeId: string, body: string, fingerprint: string): Extract<ExplanationEvent, { type: "version" }> => ({
	type: "version", nodeId, version: 1, body, author: "agent", sourceRefs: [], styleVersion: "s",
	fingerprint, noSource: false, proposed: false, at: T0,
});

function input(over: Partial<PanelInput> = {}): PanelInput {
	return {
		graph,
		explanationEvents: [],
		goalEvents: [],
		sources: {},
		costAllowed: true,
		availableActions: ["askInChat", "useAsGoalTarget"],
		...over,
	};
}

describe("buildNodePanel", () => {
	it("returns null for an unknown node", () => {
		assert.equal(buildNodePanel("n_zzz", input()), null);
	});

	it("shows the statement and, with no sources, an unverified trust level and empty sections", () => {
		const p = buildNodePanel("n_c", input());
		assert.equal(p?.node.statement, "N_C holds.");
		assert.deepEqual(p?.trust, { level: "unverified", evidence: [] });
		assert.deepEqual([p?.citingLectures, p?.cards, p?.review, p?.goals], [[], [], null, []]);
		assert.deepEqual(p?.availableActions, ["askInChat", "useAsGoalTarget"]);
	});

	it("lists concluding chains (alternatives) and the chains it is a premise of", () => {
		const p = buildNodePanel("n_c", input());
		assert.deepEqual(p?.concluding.map((c) => c.chainId), ["arg_1", "arg_2"]);
		assert.deepEqual(p?.concluding[0]?.premises, [{ id: "n_a", name: "N_A" }, { id: "n_b", name: "N_B" }]);
		assert.deepEqual(p?.usedAsPremise, [{ chainId: "arg_3", coPremises: [], conclusion: { id: "n_d", name: "N_D" } }]);
		const a = buildNodePanel("n_a", input());
		assert.deepEqual(a?.usedAsPremise.find((u) => u.chainId === "arg_1")?.coPremises, [{ id: "n_b", name: "N_B" }]);
	});

	it("explanation state: missing, with ceiling flag when generation is blocked (REQ-node-05)", () => {
		assert.deepEqual(buildNodePanel("n_c", input())?.explanation.state, "missing");
		assert.equal(buildNodePanel("n_c", input())?.explanation.ceiling, false);
		assert.equal(buildNodePanel("n_c", input({ costAllowed: false }))?.explanation.ceiling, true);
	});

	it("explanation state: current when the fingerprint matches, stale when it does not (REQ-node-03)", () => {
		const fingerprint = "n_a|n_a,n_b";
		const fresh = buildNodePanel("n_c", input({ explanationEvents: [version("n_c", "C because [[n_a]].", fingerprint)] }));
		assert.equal(fresh?.explanation.state, "current");
		assert.equal(fresh?.explanation.ceiling, false);
		assert.deepEqual(fresh?.explanation.linkNames, { n_a: "N_A" });
		const stale = buildNodePanel("n_c", input({ explanationEvents: [version("n_c", "Old.", "other")], costAllowed: false }));
		assert.equal(stale?.explanation.state, "stale");
		assert.equal(stale?.explanation.ceiling, true);
		assert.equal(stale?.explanation.current?.body, "Old.");
	});

	it("complex nodes get the long form (REQ-node-06)", () => {
		assert.equal(buildNodePanel("n_c", input())?.explanation.form, "short");
		const deep = graphWith(
			["n_1", "n_2", "n_3", "n_4"].map((i) => node(i)),
			[chain("a1", ["n_1"], "n_2"), chain("a2", ["n_2"], "n_3"), chain("a3", ["n_3"], "n_4")],
		);
		assert.equal(buildNodePanel("n_4", input({ graph: deep }))?.explanation.form, "long");
	});

	it("derives back-links from other nodes' current explanations (REQ-node-15)", () => {
		const events = [version("n_d", "D uses [[n_c]].", "n_c"), version("n_b", "B alone.", "")];
		const p = buildNodePanel("n_c", input({ explanationEvents: events }));
		assert.deepEqual(p?.mentionedBy, [{ id: "n_d", name: "N_D" }]);
	});

	it("shows a pending proposal separately from the current text", () => {
		const events: ExplanationEvent[] = [
			{ ...version("n_c", "Mine.", "n_a|n_a,n_b"), author: "user" },
			{ ...version("n_c", "Agent text [[n_b]].", "n_a|n_a,n_b"), version: 2, proposed: true },
		];
		const p = buildNodePanel("n_c", input({ explanationEvents: events }));
		assert.equal(p?.explanation.current?.body, "Mine.");
		assert.equal(p?.explanation.proposal?.body, "Agent text [[n_b]].");
		assert.deepEqual(p?.explanation.linkNames, { n_b: "N_B" });
	});

	it("includes the goals whose scope holds the node, marking targets", () => {
		const goalEvents: GoalEvent[] = [
			{ type: "created", goalId: "goal_1", title: "Master D", origin: "user", originRef: "", targetNodeIds: ["n_d"], priority: 3, at: T0 },
		];
		const c = buildNodePanel("n_c", input({ goalEvents }));
		assert.deepEqual(c?.goals, [{ id: "goal_1", title: "Master D", status: "active", isTarget: false }]);
		assert.equal(buildNodePanel("n_d", input({ goalEvents }))?.goals[0]?.isTarget, true);
		assert.deepEqual(buildNodePanel("n_zzz2", input({ goalEvents })), null);
	});

	it("passes through what the sources supply", () => {
		const p = buildNodePanel("n_c", input({
			sources: {
				trust: () => ({ level: "sourced", evidence: [{ sourceId: "s1", locator: "p. 3", quote: "q", stance: "supports", tier: "primary", snapshotHash: "h" }] }),
				lecturesCiting: () => [{ lectureId: "l1", title: "Lecture 1" }],
				cards: () => [{ cardId: "c1", question: "Why?", status: "active" }],
				review: () => ({ dueAt: T0, reps: 2, pinned: false, retired: false }),
			},
		}));
		assert.equal(p?.trust.level, "sourced");
		assert.equal(p?.citingLectures[0]?.title, "Lecture 1");
		assert.equal(p?.cards[0]?.question, "Why?");
		assert.equal(p?.review?.reps, 2);
	});

	it("neighbourhood reaches depth 2 around the node", () => {
		const p = buildNodePanel("n_c", input());
		const ids = (d: number) => p?.neighbourhood.nodes.filter((n) => n.depth === d).map((n) => n.id).sort();
		assert.deepEqual(ids(1), ["n_a", "n_b", "n_d"]);
		assert.deepEqual(ids(2), ["n_e"]);
	});
});
