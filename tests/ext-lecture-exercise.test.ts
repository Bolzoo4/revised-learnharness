// tests/ext-lecture-exercise.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exerciseDoneAtZero, exerciseDoneOnLeave, type PlayedBlock } from "../components/ext/lecture-exercise.ts";

const ex: PlayedBlock = { id: "b2", role: "exercise" };
const narrate: PlayedBlock = { id: "b1", role: "narrate" };

describe("the countdown reaching zero completes the exercise (REQ-deb-03, REQ-lec-10)", () => {
	it("records the exercise at zero, including on the last block", () => {
		assert.equal(exerciseDoneAtZero(ex, 0), "b2");
		assert.equal(exerciseDoneAtZero({ id: "last", role: "exercise" }, 0), "last");
	});
	it("records nothing while time remains, for a narration, or without a countdown", () => {
		assert.equal(exerciseDoneAtZero(ex, 1), null);
		assert.equal(exerciseDoneAtZero(ex, null), null);
		assert.equal(exerciseDoneAtZero(narrate, 0), null);
		assert.equal(exerciseDoneAtZero(undefined, 0), null);
	});
	it("hostile values: a negative or fractional remaining, an unknown role, a case-changed role", () => {
		assert.equal(exerciseDoneAtZero(ex, -1), null);
		assert.equal(exerciseDoneAtZero(ex, 0.5), null);
		assert.equal(exerciseDoneAtZero({ id: "x", role: "EXERCISE" }, 0), null);
		assert.equal(exerciseDoneAtZero({ id: "x", role: "" }, 0), null);
	});
});

describe("leaving an exercise forward while its countdown runs counts as done", () => {
	it("Next or Done with time left records it", () => {
		assert.equal(exerciseDoneOnLeave(ex, 30, 1, 2), "b2");
		assert.equal(exerciseDoneOnLeave(ex, 1, 1, 2), "b2");
	});
	it("never records twice: a countdown at zero was recorded when it ended", () => {
		assert.equal(exerciseDoneOnLeave(ex, 0, 1, 2), null);
	});
	it("no countdown started, backwards, or in place: nothing", () => {
		assert.equal(exerciseDoneOnLeave(ex, null, 1, 2), null);
		assert.equal(exerciseDoneOnLeave(ex, 30, 2, 1), null);
		assert.equal(exerciseDoneOnLeave(ex, 30, 2, 2), null);
	});
	it("hostile values: NaN, negative and non-exercise blocks never record", () => {
		assert.equal(exerciseDoneOnLeave(ex, Number.NaN, 1, 2), null);
		assert.equal(exerciseDoneOnLeave(ex, -5, 1, 2), null);
		assert.equal(exerciseDoneOnLeave(narrate, 30, 1, 2), null);
		assert.equal(exerciseDoneOnLeave(undefined, 30, 1, 2), null);
	});
	it("a rapid sequence records each exercise exactly once", () => {
		const blocks: PlayedBlock[] = [ex, { id: "b3", role: "exercise" }, narrate];
		const recorded: string[] = [];
		// b2: Next while 5s remain (left early, recorded on leave); then b3 runs its countdown to zero (recorded at zero).
		const left = exerciseDoneOnLeave(blocks[0], 5, 0, 1);
		if (left) recorded.push(left);
		const zeroed = exerciseDoneAtZero(blocks[1], 0);
		if (zeroed) recorded.push(zeroed);
		const after = exerciseDoneOnLeave(blocks[1], 0, 1, 2); // the advance after zero must not record b3 again
		if (after) recorded.push(after);
		assert.deepEqual(recorded, ["b2", "b3"]);
	});
});
