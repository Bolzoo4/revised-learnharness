// tests/ext-debrief-facts.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExerciseSetState } from "../src/core/ext/practice/exercises.ts";
import type { OfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { ReviewEvent } from "../src/core/ext/review.ts";
import {
	computeExerciseFacts,
	computeLectureFacts,
	computeOfficeHoursFacts,
	computeReviewFacts,
	computeStudyFacts,
	countUnanswered,
	hasSubstance,
	spanSec,
	type TranscriptLine,
} from "../src/core/ext/debrief/facts.ts";

const T0 = "2026-11-04T10:00:00.000Z";
const T1 = "2026-11-04T10:30:00.000Z";
const names = new Map([["n_a", "Alpha"], ["n_b", "Beta"], ["n_c", "Gamma"]]);
const review = (nodeId: string, rating: 1 | 2 | 3 | 4, at: string, over: Partial<Extract<ReviewEvent, { type: "review" }>> = {}): ReviewEvent => ({
	type: "review", nodeId, channel: "fixed", rating, durationSec: 20, at, ...over,
});
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

describe("computeReviewFacts (REQ-deb-03)", () => {
	const base = { startedAt: T0, endedAt: T1, owns: () => true, names, budgetSec: 1500 };
	it("counts channels, ratings, lapses and time against the budget", () => {
		const f = computeReviewFacts({
			...base,
			events: [
				review("n_a", 3, at(1)),
				review("n_b", 1, at(2), { durationSec: 100 }),
				review("n_a", 4, at(3), { channel: "dialogic", durationSec: 200, weakPremises: ["n_b", "n_b", "n_c"] }),
			],
		});
		assert.deepEqual(f.perChannel, { fixed: 2, dialogic: 1 });
		assert.deepEqual(f.ratings, { "1": 1, "2": 0, "3": 1, "4": 1 });
		assert.equal(f.lapses, 1);
		assert.equal(f.reviews, 3);
		assert.equal(f.reviewSec, 320);
		assert.equal(f.budgetRatio, 0.213);
		assert.equal(f.durationSec, 1800);
		assert.deepEqual(f.weakPremises, [{ nodeId: "n_b", name: "Beta", count: 1 }, { nodeId: "n_c", name: "Gamma", count: 1 }]);
	});
	it("is deterministic: the same input gives the same facts, whatever the order of equal weak premises", () => {
		const events = [review("n_a", 2, at(1), { channel: "dialogic", weakPremises: ["n_c", "n_b"] })];
		assert.deepEqual(computeReviewFacts({ ...base, events }), computeReviewFacts({ ...base, events: [...events] }));
		assert.deepEqual(computeReviewFacts({ ...base, events }).weakPremises.map((w) => w.nodeId), ["n_b", "n_c"]);
	});
	it("ignores exercise-channel, implicit and mark events, events of deleted nodes, other windows and events the session does not own", () => {
		const f = computeReviewFacts({
			...base,
			owns: (a) => a !== at(5),
			events: [
				review("n_a", 3, at(1), { channel: "exercise", durationSec: 0 }),
				{ type: "implicit", nodeId: "n_a", viaNodeId: "n_b", outcome: "credit", at: at(2) },
				{ type: "pin", nodeId: "n_a", pinned: true, at: at(2) },
				review("n_gone", 3, at(3)),
				review("n_a", 3, "2026-11-04T09:59:59.000Z"),
				review("n_a", 3, "2026-11-04T10:30:01.000Z"),
				review("n_a", 3, at(5)),
				review("n_a", 3, at(0)),
			],
		});
		assert.equal(f.reviews, 1);
	});
	it("an empty session has zero everything and a null ratio for a missing budget", () => {
		const f = computeReviewFacts({ ...base, events: [], budgetSec: 0 });
		assert.equal(f.reviews, 0);
		assert.equal(f.budgetRatio, null);
		assert.equal(hasSubstance(f), false);
		assert.equal(computeReviewFacts({ ...base, events: [], budgetSec: Number.NaN }).budgetSec, 0);
	});
	it("ignores weak premises that are not existing nodes and caps the list at ten", () => {
		const many = Array.from({ length: 12 }, (_, i) => `n_${i}`);
		const bigNames = new Map(many.map((id) => [id, id] as const).concat([["n_a", "Alpha"]]));
		const f = computeReviewFacts({ ...base, names: bigNames, events: [review("n_a", 2, at(1), { channel: "dialogic", weakPremises: [...many, "n_ghost"] })] });
		assert.equal(f.weakPremises.length, 10);
		assert.ok(!f.weakPremises.some((w) => w.nodeId === "n_ghost"));
	});
});

describe("computeLectureFacts", () => {
	const lecture = { title: "Measures", slideIds: ["s1", "s2", "s3"], exerciseBlockIds: ["b4"] };
	it("counts what was seen against what exists", () => {
		const f = computeLectureFacts({ startedAt: T0, endedAt: T1, lectureId: "L", lecture, slides: new Set(["s1", "s2", "sX"]), concepts: new Set(["n_a"]), exercises: new Set(["b4"]) });
		assert.equal(f.slidesViewed, 2); // sX is not a slide of the lecture
		assert.equal(f.slidesTotal, 3);
		assert.equal(f.exercisesDone, 1);
		assert.equal(f.exercisesTotal, 1);
		assert.equal(f.title, "Measures");
		assert.equal(hasSubstance(f), true);
	});
	it("a deleted lecture keeps the raw counts and null totals", () => {
		const f = computeLectureFacts({ startedAt: T0, endedAt: T1, lectureId: "L", lecture: null, slides: new Set(["s1"]), concepts: new Set(), exercises: new Set() });
		assert.equal(f.slidesViewed, 1);
		assert.equal(f.slidesTotal, null);
		assert.equal(f.title, null);
	});
});

describe("office hours facts", () => {
	const line = (role: "user" | "assistant", min: number, text: string): TranscriptLine => ({ role, at: Date.parse(at(min)), text });
	const verdict = (chatId: string, stances: Array<["matches" | "differs" | "missing", string]>, outcome: "consistent" | "differs" | "not_verifiable", min: number): OfficeHoursEvent => ({
		type: "verdict", chatId, outcome, discarded: 0, at: at(min),
		items: stances.map(([stance, stepRef]) => ({ stepRef, sourceQuote: "q".repeat(25), workQuote: "w", stance })),
	});
	it("counts verdicts, questioned steps (distinct, across verdicts) and the latest verdict's items", () => {
		const f = computeOfficeHoursFacts({
			chatId: "c1", startedAt: T0, endedAt: T1,
			events: [
				{ type: "designated", chatId: "c1", label: "Manual ch. 3", sha256: "a".repeat(64), at: at(0) },
				verdict("c1", [["differs", "s1"], ["missing", "s2"], ["matches", "s3"]], "differs", 5),
				verdict("c1", [["differs", "s1"], ["matches", "s2"]], "differs", 10),
				verdict("other", [["differs", "s9"]], "differs", 11),
			],
			transcript: [line("user", 1, "my proof"), line("user", 2, "   ")],
		});
		assert.equal(f.designatedSource, "Manual ch. 3");
		assert.deepEqual(f.verdicts, { consistent: 0, differs: 2, not_verifiable: 0 });
		assert.equal(f.stepsQuestioned, 2);
		assert.deepEqual(f.latestItems, { matches: 1, differs: 1, missing: 0 });
		assert.equal(f.learnerMessages, 1);
	});
	it("counts the tutor's questions the learner did not answer", () => {
		const lines = [line("assistant", 0, "Why does step 2 hold?"), line("user", 1, "because of lemma 1"), line("assistant", 2, "Where did you use compactness?"), line("assistant", 3, "Also, what about step 4?"), line("assistant", 4, "Good."), line("assistant", 5, "Ready for the next one?")];
		assert.equal(countUnanswered(lines), 3);
		assert.equal(countUnanswered([]), 0);
		assert.equal(countUnanswered([line("user", 0, "hi")]), 0);
		assert.equal(countUnanswered([line("assistant", 0, "Done.")]), 0);
		assert.equal(countUnanswered([line("assistant", 0, "Is it **true**?")]), 1);
	});
	it("lines outside the window are ignored; a session with no learner message and no verdict has no substance", () => {
		const f = computeOfficeHoursFacts({ chatId: "c1", startedAt: T0, endedAt: T1, events: [], transcript: [line("user", 45, "late")] });
		assert.equal(f.learnerMessages, 0);
		assert.equal(hasSubstance(f), false);
	});
});

describe("exercise and study facts", () => {
	const set: ExerciseSetState = {
		setId: "set_1", goalId: "goal_1", createdAt: T0, applied: { reached: true },
		exercises: [
			{ id: "e1", prompt: "p", nodeIds: ["n_a", "n_b"], steps: [] },
			{ id: "e2", prompt: "p", nodeIds: ["n_a", "n_c"], steps: [] },
		],
		graded: new Map([
			["e1", { type: "graded", setId: "set_1", exerciseId: "e1", outcome: "consistent", nodeOutcomes: [{ nodeId: "n_a", outcome: "passed" }, { nodeId: "n_b", outcome: "weak" }], lowConfidence: false, at: at(5) }],
			["e2", { type: "graded", setId: "set_1", exerciseId: "e2", outcome: "differs", nodeOutcomes: [{ nodeId: "n_a", outcome: "failed" }, { nodeId: "n_gone", outcome: "failed" }], lowConfidence: true, at: at(9) }],
		]),
	};
	it("takes the worst outcome per node, skips deleted nodes and reports application", () => {
		const f = computeExerciseFacts({ set, startedAt: T0, endedAt: T1, names });
		assert.deepEqual(f.nodes, [{ nodeId: "n_a", name: "Alpha", outcome: "failed" }, { nodeId: "n_b", name: "Beta", outcome: "weak" }]);
		assert.equal(f.exercisesGraded, 2);
		assert.equal(f.lowConfidenceGradings, 1);
		assert.equal(f.goalReached, true);
		assert.equal(hasSubstance(f), true);
		assert.equal(hasSubstance(computeExerciseFacts({ set: { ...set, graded: new Map(), applied: null }, startedAt: T0, endedAt: T1, names })), false);
	});
	it("study facts count distinct valid pages, messages in the window and cards on linked nodes", () => {
		const f = computeStudyFacts({
			startedAt: T0, endedAt: T1, document: { documentId: "d".repeat(64), title: "Book" },
			pagesRead: [3, 3, 4, 0, -1, 2.5],
			transcript: [{ role: "user", at: Date.parse(at(1)), text: "q" }, { role: "assistant", at: Date.parse(at(1)), text: "a" }, { role: "user", at: Date.parse(at(60)), text: "late" }],
			linkedNodeIds: ["n_a", "n_a", "n_b"],
			createdCards: [{ nodeId: "n_a", at: at(2) }, { nodeId: "n_c", at: at(2) }, { nodeId: "n_b", at: at(99) }],
		});
		assert.equal(f.pagesRead, 2);
		assert.equal(f.learnerMessages, 1);
		assert.equal(f.nodesLinked, 2);
		assert.equal(f.cardsCreated, 1);
	});
	it("a study session without a registered document still produces facts", () => {
		const f = computeStudyFacts({ startedAt: T0, endedAt: T1, document: null, pagesRead: [], transcript: [], linkedNodeIds: [], createdCards: [] });
		assert.equal(f.documentId, null);
		assert.equal(hasSubstance(f), false);
	});
});

describe("spanSec", () => {
	it("is whole seconds, zero for reversed or unparseable spans", () => {
		assert.equal(spanSec(T0, T1), 1800);
		assert.equal(spanSec(T1, T0), 0);
		assert.equal(spanSec("bad", T1), 0);
		assert.equal(spanSec(T0, "2026-11-04T10:00:00.999Z"), 0);
	});
});
