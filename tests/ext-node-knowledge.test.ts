// tests/ext-node-knowledge.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveGoals, type GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import { createNodeKnowledge, NodeKnowledgeError, type NodeKnowledgeDeps } from "../src/server/ext/node-knowledge.ts";
import { chain, closedGate, fakeWriter, graphWith, memoryExplanations, node, openGate, T0 } from "./helpers/ext-node-fixtures.ts";

function memoryGoals(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

function setup(over: Partial<NodeKnowledgeDeps> = {}) {
	const graphStore = graphWith([node("n_a", "Alpha"), node("n_b", "Beta")], [chain("arg_1", ["n_a"], "n_b")]);
	const explanations = memoryExplanations();
	const goalsStore = memoryGoals();
	const writer = fakeWriter((id) => `${id} is explained.`);
	const deps: NodeKnowledgeDeps = {
		graphStore,
		explanations,
		goalsStore,
		writer,
		cost: openGate(),
		sources: {},
		handlers: {},
		now: () => T0,
		...over,
	};
	return { knowledge: createNodeKnowledge(deps), explanations, goalsStore, writer, deps };
}

async function status(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
	} catch (e) {
		return e instanceof NodeKnowledgeError ? e.status : undefined;
	}
	return undefined;
}

describe("createNodeKnowledge", () => {
	it("panel: 404 for an unknown node; the built-in actions are always available", async () => {
		const s = setup();
		assert.equal(await status(() => s.knowledge.panel("n_zzz")), 404);
		assert.deepEqual(s.knowledge.panel("n_a").availableActions, ["askInChat", "useAsGoalTarget"]);
	});

	it("panel: an action is available only when its handler is installed (REQ-node-14)", () => {
		const s = setup({ handlers: { verifyNow: async () => undefined, pin: async () => undefined } });
		assert.deepEqual(s.knowledge.panel("n_a").availableActions, ["pin", "askInChat", "useAsGoalTarget", "verifyNow"]);
	});

	it("panel reports the ceiling when the gate is closed (REQ-node-05)", () => {
		const s = setup({ cost: closedGate() });
		const p = s.knowledge.panel("n_b");
		assert.equal(p.explanation.state, "missing");
		assert.equal(p.explanation.ceiling, true);
	});

	it("ensureExplanation writes the text, then the panel shows it as current", async () => {
		const s = setup();
		const result = await s.knowledge.ensureExplanation("n_b");
		assert.deepEqual(result.written, ["n_b"]);
		const p = s.knowledge.panel("n_b");
		assert.equal(p.explanation.state, "current");
		assert.equal(p.explanation.current?.noSource, true);
	});

	it("ensureExplanation uses the node's verification quotes as source context", async () => {
		const s = setup({
			sources: {
				trust: () => ({
					level: "sourced",
					evidence: [
						{ sourceId: "s1", locator: "p. 1", quote: "Alpha implies beta.", stance: "supports", tier: "primary", snapshotHash: "h1" },
						{ sourceId: "s2", locator: "p. 2", quote: "Beta follows.", stance: "supports", tier: "secondary", snapshotHash: "h1" },
					],
				}),
			},
		});
		await s.knowledge.ensureExplanation("n_b");
		assert.equal(s.writer.requests[0]?.source?.text, "Alpha implies beta.\n\nBeta follows.");
		assert.deepEqual(s.writer.requests[0]?.source?.refs, ["h1"]);
		assert.equal(s.knowledge.panel("n_b").explanation.current?.noSource, false);
	});

	it("two concurrent openings share one generation (single flight)", async () => {
		const s = setup();
		const [x, y] = await Promise.all([s.knowledge.ensureExplanation("n_b"), s.knowledge.ensureExplanation("n_b")]);
		assert.equal(s.writer.requests.length, 1);
		assert.deepEqual(x, y);
	});

	it("ensureExplanation: 404 for an unknown node, ceilingReached when closed", async () => {
		assert.equal(await status(() => setup().knowledge.ensureExplanation("n_zzz")), 404);
		const closed = setup({ cost: closedGate() });
		assert.equal((await closed.knowledge.ensureExplanation("n_b")).ceilingReached, true);
		assert.equal(closed.writer.requests.length, 0);
	});

	it("generateForNodes is the chapter-run entry: batches, with the chapter text", async () => {
		const s = setup();
		const result = await s.knowledge.generateForNodes({ nodeIds: ["n_a", "n_b"], source: { text: "Chapter.", refs: ["h"] } });
		assert.deepEqual(result.written, ["n_a", "n_b"]);
		assert.equal(s.writer.requests[0]?.source?.text, "Chapter.");
	});

	it("saveExplanation stores a user text; bad input is a 400, unknown node a 404", async () => {
		const s = setup();
		assert.deepEqual(s.knowledge.saveExplanation("n_b", "Beta because [[n_a]]."), { version: 1 });
		assert.equal(await status(() => s.knowledge.saveExplanation("n_b", "See [[n_x]].")), 400);
		assert.equal(await status(() => s.knowledge.saveExplanation("n_zzz", "Text.")), 404);
	});

	it("decide: approving a pending proposal; 409 when there is none", async () => {
		const s = setup();
		s.knowledge.saveExplanation("n_b", "Mine.");
		// a new argument makes the user text stale, so the agent writes a proposal over it
		s.deps.graphStore.appendNode(node("n_c"));
		s.deps.graphStore.appendChain(chain("arg_2", ["n_c"], "n_b"));
		await s.knowledge.ensureExplanation("n_b");
		assert.equal(s.knowledge.panel("n_b").explanation.proposal?.body, "n_b is explained.");
		s.knowledge.decide("n_b", "approved");
		assert.equal(s.knowledge.panel("n_b").explanation.current?.body, "n_b is explained.");
		assert.equal(await status(() => s.knowledge.decide("n_b", "approved")), 409);
	});

	it("runAction useAsGoalTarget creates a goal targeting the existing node", async () => {
		const s = setup();
		await s.knowledge.runAction("n_b", "useAsGoalTarget");
		const goals = deriveGoals(s.goalsStore.readEvents());
		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0]?.targetNodeIds, ["n_b"]);
		assert.equal(goals[0]?.title, "Beta");
		assert.equal(s.knowledge.panel("n_b").goals[0]?.isTarget, true);
	});

	it("runAction calls an installed handler, 501 when absent, 400 for the client-side action", async () => {
		const called: string[] = [];
		const s = setup({ handlers: { verifyNow: async (id) => void called.push(id) } });
		await s.knowledge.runAction("n_a", "verifyNow");
		assert.deepEqual(called, ["n_a"]);
		assert.equal(await status(() => s.knowledge.runAction("n_a", "pin")), 501);
		assert.equal(await status(() => s.knowledge.runAction("n_a", "askInChat")), 400);
		assert.equal(await status(() => s.knowledge.runAction("n_zzz", "verifyNow")), 404);
	});
});
