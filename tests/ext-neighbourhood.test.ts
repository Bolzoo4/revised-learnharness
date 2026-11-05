// tests/ext-neighbourhood.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighbourhood, radialPositions } from "../src/core/ext/neighbourhood.ts";

const c = (premises: string[], conclusion: string) => ({ premises, conclusion });
// e -> a -> (with b) -> x -> d ; z is far away
const chains = [c(["n_e"], "n_a"), c(["n_a", "n_b"], "n_x"), c(["n_x"], "n_d"), c(["n_z"], "n_y")];

describe("neighbourhood (REQ-node-13)", () => {
	it("depth 1 holds the centre and its direct premises and conclusions", () => {
		const h = neighbourhood("n_x", chains, 1);
		assert.deepEqual(h.nodes, [
			{ id: "n_x", depth: 0 },
			{ id: "n_a", depth: 1 },
			{ id: "n_b", depth: 1 },
			{ id: "n_d", depth: 1 },
		]);
	});

	it("depth 2 adds the next ring and the edges among included nodes", () => {
		const h = neighbourhood("n_x", chains, 2);
		assert.deepEqual(h.nodes.filter((n) => n.depth === 2), [{ id: "n_e", depth: 2 }]);
		assert.equal(h.nodes.some((n) => n.id === "n_z"), false);
		assert.deepEqual(
			[...h.edges].sort((p, q) => (p.from + p.to < q.from + q.to ? -1 : 1)),
			[
				{ from: "n_a", to: "n_x" },
				{ from: "n_b", to: "n_x" },
				{ from: "n_e", to: "n_a" },
				{ from: "n_x", to: "n_d" },
			],
		);
	});

	it("a node with no chains is alone; a premise repeated in two chains gives one edge", () => {
		assert.deepEqual(neighbourhood("n_q", chains, 2), { nodes: [{ id: "n_q", depth: 0 }], edges: [] });
		const twice = neighbourhood("n_b", [c(["n_a"], "n_b"), c(["n_a"], "n_b")], 1);
		assert.equal(twice.edges.length, 1);
	});
});

describe("radialPositions", () => {
	it("puts the centre at the origin and each ring at depth times the radius", () => {
		const h = neighbourhood("n_x", chains, 2);
		const pos = radialPositions(h.nodes, 50);
		assert.deepEqual(pos["n_x"], { x: 0, y: 0 });
		for (const n of h.nodes) {
			const p = pos[n.id];
			assert.ok(p !== undefined);
			assert.ok(Math.abs(Math.hypot(p.x, p.y) - n.depth * 50) < 1e-9, n.id);
		}
	});
});
