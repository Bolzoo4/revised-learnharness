import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VerdictItem } from "../src/core/ext/practice/verdict.ts";
import {
	deriveExerciseSets,
	isLowConfidence,
	nodeOutcomes,
	parseExerciseEvent,
	referenceText,
	setComplete,
	setResults,
	validateExerciseSet,
	type Exercise,
	type ExerciseEvent,
} from "../src/core/ext/practice/exercises.ts";

const item = (over: Partial<VerdictItem>): VerdictItem => ({
	stepRef: "s1",
	sourceQuote: "each is twice an integer",
	workQuote: "a+b = 2(k+m), which is twice an integer",
	stance: "matches",
	...over,
});

const ex = (over: Partial<Exercise> = {}): Exercise => ({
	id: "ex1",
	prompt: "Show that the sum of two even numbers is even.",
	nodeIds: ["n_a", "n_b"],
	steps: [
		{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
		{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_a", "n_b"] },
	],
	...over,
});
const CTX = { scope: new Set(["n_a", "n_b", "n_c"]), targetNodeIds: ["n_c"], statements: new Map([["n_a", "Every even number is twice an integer, a fact used everywhere."]]) };

describe("validateExerciseSet (REQ-lec-15)", () => {
	const covering = ex({ nodeIds: ["n_a", "n_c"], steps: [{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a", "n_c"] }] });
	it("accepts a set over scope nodes that covers the targets", () => {
		assert.deepEqual(validateExerciseSet([covering], CTX), []);
	});
	it("rejects an exercise on a single node, outside the scope, or covering no target", () => {
		const text = validateExerciseSet([ex({ nodeIds: ["n_a"] }), ex({ id: "ex2", nodeIds: ["n_a", "n_zzz"] })], CTX).join("\n");
		assert.match(text, /at least 2 nodes/);
		assert.match(text, /n_zzz, which is outside the goal's scope/);
		assert.match(text, /no exercise covers the goal's target node n_c/);
	});
	it("rejects a recall question that restates a node statement, short steps, and uncited steps", () => {
		const bad = ex({
			nodeIds: ["n_a", "n_c"],
			prompt: "Every even number is twice an integer, a fact used everywhere. Prove it.",
			steps: [{ id: "s1", text: "too short", nodeIds: [] }],
		});
		const text = validateExerciseSet([bad], CTX).join("\n");
		assert.match(text, /full statement of n_a/);
		assert.match(text, /shorter than 20/);
		assert.match(text, /cites no node/);
	});
	it("rejects empty sets and duplicate ids", () => {
		assert.match(validateExerciseSet([], CTX).join(), /no exercises/);
		assert.match(validateExerciseSet([covering, covering], CTX).join(), /duplicate exercise id/);
	});
});

describe("grading (REQ-lec-16, 17)", () => {
	it("low confidence when the reference uses any node that is not sourced", () => {
		const e = ex();
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"], ["n_b", "sourced"]])), false);
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"]])), true);
		assert.equal(isLowConfidence(e, new Map([["n_a", "sourced"], ["n_b", "contested"]])), true);
	});
	it("derives node outcomes from the steps that cite each node", () => {
		const kept: VerdictItem[] = [item({ stepRef: "s1" }), item({ stepRef: "s2", stance: "differs" })];
		assert.deepEqual(nodeOutcomes(ex(), kept), [
			{ nodeId: "n_a", outcome: "weak" }, // s1 good, s2 bad
			{ nodeId: "n_b", outcome: "failed" }, // only s2, bad
		]);
		assert.deepEqual(nodeOutcomes(ex(), [item({ stepRef: "s1" }), item({ stepRef: "s2" })]).map((o) => o.outcome), ["passed", "passed"]);
		assert.deepEqual(nodeOutcomes(ex(), []), []);
	});
	it("renders the reference with step ids", () => {
		assert.equal(referenceText(ex()), "[s1] Write each number as twice an integer.\n[s2] Add them and factor out the two.");
	});
});

const T = "2026-11-04T10:00:00.000Z";
describe("exercise sets", () => {
	const created: ExerciseEvent = { type: "set_created", setId: "set1", goalId: "goal_1", exercises: [ex(), ex({ id: "ex2" })], at: T };
	const graded = (exerciseId: string, over: Partial<Extract<ExerciseEvent, { type: "graded" }>> = {}): ExerciseEvent => ({
		type: "graded", setId: "set1", exerciseId, outcome: "consistent", nodeOutcomes: [{ nodeId: "n_a", outcome: "passed" }], lowConfidence: false, at: T, ...over,
	});
	it("round-trips events through the parser and rejects bad ones", () => {
		for (const e of [created, graded("ex1"), { type: "applied", setId: "set1", reached: true, at: T } as ExerciseEvent]) assert.deepEqual(parseExerciseEvent(JSON.parse(JSON.stringify(e))), e);
		assert.equal(parseExerciseEvent({ ...graded("ex1"), outcome: "correct" }), null);
		assert.equal(parseExerciseEvent({ type: "set_created", setId: "s", goalId: "g", exercises: [], at: T }), null);
	});
	it("is complete only when every exercise has a verifiable grading", () => {
		const open = deriveExerciseSets([created, graded("ex1")])[0]!;
		assert.equal(setComplete(open), false);
		const unverifiable = deriveExerciseSets([created, graded("ex1"), graded("ex2", { outcome: "not_verifiable", nodeOutcomes: [] })])[0]!;
		assert.equal(setComplete(unverifiable), false);
		assert.equal(setComplete(deriveExerciseSets([created, graded("ex1"), graded("ex2")])[0]!), true);
	});
	it("takes the latest grading per exercise and ignores gradings of unknown exercises", () => {
		const s = deriveExerciseSets([created, graded("ex1", { outcome: "differs" }), graded("ex1"), graded("zzz")])[0]!;
		assert.equal(s.graded.get("ex1")!.outcome, "consistent");
		assert.equal(s.graded.size, 1);
	});
	it("aggregates the worst outcome per node and withholds passes of low-confidence gradings", () => {
		const s = deriveExerciseSets([
			created,
			graded("ex1", { nodeOutcomes: [{ nodeId: "n_a", outcome: "passed" }, { nodeId: "n_b", outcome: "passed" }] }),
			graded("ex2", { lowConfidence: true, nodeOutcomes: [{ nodeId: "n_a", outcome: "weak" }, { nodeId: "n_c", outcome: "passed" }] }),
		])[0]!;
		assert.deepEqual(setResults(s).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
			{ nodeId: "n_a", outcome: "weak" },
			{ nodeId: "n_b", outcome: "passed" },
		]);
	});
});
