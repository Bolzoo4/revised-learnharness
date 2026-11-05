import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citingLectures, lectureOverlay } from "../src/core/ext/lecture/lecture-graph.ts";
import { activeCue } from "../src/core/ext/lecture/cues.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

describe("lecture overlay (REQ-lec-11)", () => {
	it("derives one special node per lecture and cites edges to existing nodes only", () => {
		const o = lectureOverlay([makeLecture()], new Set([NODE_A]));
		assert.deepEqual(o.nodes, [{ id: "lec_b0123abcd_c02_l01", title: "Sigma algebras", kind: "lecture" }]);
		assert.deepEqual(o.edges, [{ from: "lec_b0123abcd_c02_l01", to: NODE_A, type: "cites" }]);
	});
	it("derives edges for slide links too", () => {
		const o = lectureOverlay([makeLecture()], new Set([NODE_A, NODE_B]));
		assert.deepEqual(o.edges.map((e) => e.to), [NODE_A, NODE_B]);
	});
});

describe("back-links (REQ-lec-12)", () => {
	it("lists citing lectures in id order and none for an uncited node", () => {
		const second = makeLecture({ id: "lec_b0123abcd_c01_l01", title: "Earlier" });
		const r = citingLectures(NODE_A, [makeLecture(), second]);
		assert.deepEqual(r.map((x) => x.title), ["Earlier", "Sigma algebras"]);
		assert.deepEqual(citingLectures("n_nobody00", [makeLecture()]), []);
	});
});

describe("activeCue", () => {
	const cues = [
		{ atChar: 0, target: "a", style: "box" as const },
		{ atChar: 10, target: "b", style: "underline" as const },
	];
	it("returns the last cue at or before the offset", () => {
		assert.equal(activeCue(cues, 0)?.target, "a");
		assert.equal(activeCue(cues, 9)?.target, "a");
		assert.equal(activeCue(cues, 10)?.target, "b");
		assert.equal(activeCue(cues, 500)?.target, "b");
	});
	it("returns null before the first cue and for no cues", () => {
		assert.equal(activeCue([{ atChar: 5, target: "a", style: "box" }], 2), null);
		assert.equal(activeCue([], 3), null);
	});
});
