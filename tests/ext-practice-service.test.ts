import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { Exercise, ExerciseEvent, NodeOutcome } from "../src/core/ext/practice/exercises.ts";
import { parseExerciseEvent } from "../src/core/ext/practice/exercises.ts";
import { parseOfficeHoursEvent, type OfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import type { TrustLevel } from "../src/core/ext/trust.ts";
import { createPracticeService, PracticeError, type PracticeServiceDeps } from "../src/server/ext/practice-service.ts";

const SRC = "Write each number as twice an integer.\nAdd them and factor out the two.";
const exercise = (over: Partial<Exercise> = {}): Exercise => ({
	id: "ex1",
	prompt: "Show that the sum of two even numbers is even.",
	nodeIds: ["n_a", "n_b"],
	steps: [
		{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
		{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_b"] },
	],
	...over,
});

function harness(opts: { trust?: Record<string, TrustLevel>; generated?: Exercise[][]; allowed?: boolean } = {}) {
	const oh: OfficeHoursEvent[] = [];
	const ex: ExerciseEvent[] = [];
	const snaps = new Map<string, string>();
	const applied: Array<{ goalId: string; results: Array<{ nodeId: string; outcome: NodeOutcome }> }> = [];
	const prompts: Array<string | null> = [];
	const queue = [...(opts.generated ?? [[exercise({ nodeIds: ["n_a", "n_c"], steps: [{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a", "n_c"] }] })]])];
	let chats = 0;
	const deps: PracticeServiceDeps = {
		officeHours: { append: (e) => void oh.push(parseOfficeHoursEvent(e)!), readAll: () => [...oh] },
		exercises: { append: (e) => void ex.push(parseExerciseEvent(e)!), readAll: () => [...ex] },
		snapshots: {
			put: (t) => {
				const h = createHash("sha256").update(t).digest("hex");
				snaps.set(h, t);
				return h;
			},
			get: (h) => snaps.get(h) ?? null,
		},
		gate: { allowed: () => opts.allowed ?? true, record: () => {} },
		createSession: () => ({ id: `chat_${++chats}` }),
		goalScope: (id) => (id === "goal_1" ? { title: "Even sums", targetNodeIds: ["n_c"], scope: ["n_a", "n_b", "n_c"], status: "active" } : null),
		nodes: (ids) => ids.map((id) => ({ id, name: id, statement: `statement of ${id}` })),
		trust: (ids) => new Map(ids.map((id) => [id, opts.trust?.[id] ?? "sourced"] as const)),
		writeExerciseSet: async (input) => {
			prompts.push(input.feedback);
			return queue.shift() ?? [];
		},
		applyExerciseResult: (input) => {
			applied.push(input);
			return { reached: input.results.every((r) => r.outcome === "passed") };
		},
		now: () => "2026-11-04T10:00:00.000Z",
		newId: () => "abc",
	};
	return { svc: createPracticeService(deps), oh, ex, applied, prompts };
}

const item = (stepRef: string, sourceQuote: string, workQuote: string, stance: "matches" | "differs" | "missing" = "matches") => ({ stepRef, sourceQuote, workQuote, stance });
const WORK = "Let a = 2k and b = 2m. Then a + b = 2(k + m).";

describe("free office-hours session (REQ-lec-12, 13, 14)", () => {
	it("designates a snapshot of the pasted source and answers read_source from it", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "Manual ch.3", sourceText: SRC });
		assert.equal(s.chatId, "chat_1");
		assert.equal(h.svc.sourceOf(s.chatId)?.text, SRC);
	});
	it("the tool context reads the designated source and routes the verdict to the session", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "Manual ch.3", sourceText: SRC });
		const tc = h.svc.toolContext(s.chatId, { getChat: () => null });
		assert.deepEqual(tc.source(), { label: "Manual ch.3", text: SRC });
		assert.match(tc.submitVerdict([item("s1", "Write each number as twice an integer", "Let a = 2k and b = 2m")], WORK).text, /consistent/);
	});
	it("a session without a source gives no verdict", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "No source" });
		assert.equal(h.svc.sourceOf(s.chatId), null);
		assert.throws(() => h.svc.submitVerdict(s.chatId, [], WORK), (e: unknown) => e instanceof PracticeError && e.status === 409);
	});
	it("keeps items whose quotes exist and reports differences; drops invented quotes", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		const r = h.svc.submitVerdict(s.chatId, [
			item("s1", "Write each number as twice an integer", "Let a = 2k and b = 2m"),
			item("s2", "Add them and factor out the two", "Then a + b = 2(k + m)", "differs"),
			item("s3", "this quotation was never in the source at all", "Then a + b"),
		], WORK);
		assert.match(r.text, /differs from the designated source/);
		assert.match(r.text, /s2: the source says/);
		assert.match(r.text, /1 comparison\(s\) were dropped/);
		const v = h.oh.filter((e) => e.type === "verdict");
		assert.equal(v.length, 1);
		assert.equal(v[0]!.type === "verdict" && v[0]!.outcome, "differs");
	});
	it("with every quotation invented the verdict is not verifiable, never a model judgment", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		const r = h.svc.submitVerdict(s.chatId, [item("s1", "an entirely invented passage of the source", "Let a = 2k and b = 2m")], WORK);
		assert.match(r.text, /Not verifiable/);
	});
	it("refuses a verdict before the learner has written anything", () => {
		const h = harness();
		const s = h.svc.startSession({ label: "M", sourceText: SRC });
		assert.throws(() => h.svc.submitVerdict(s.chatId, [], "  "), /not written any work/);
	});
});

describe("exercise sets (REQ-lec-15)", () => {
	it("generates, validates and stores a set", async () => {
		const h = harness();
		const { setId } = await h.svc.createExerciseSet({ goalId: "goal_1" });
		assert.equal(setId, "set_abc");
		assert.equal(h.svc.getSet(setId).exercises.length, 1);
	});
	it("retries with the violations as feedback, then rejects after the retries", async () => {
		const bad = [exercise({ nodeIds: ["n_a"] })];
		const h = harness({ generated: [bad, bad, bad] });
		await assert.rejects(h.svc.createExerciseSet({ goalId: "goal_1" }), /rejected/);
		assert.equal(h.prompts.length, 3);
		assert.equal(h.prompts[0], null);
		assert.match(h.prompts[1] ?? "", /at least 2 nodes/);
		assert.equal(h.ex.length, 0);
	});
	it("refuses an unknown goal and a spent ceiling, before any model call", async () => {
		const h = harness({ allowed: false });
		await assert.rejects(h.svc.createExerciseSet({ goalId: "nope" }), /unknown or inactive/);
		await assert.rejects(h.svc.createExerciseSet({ goalId: "goal_1" }), /ceiling/);
		assert.equal(h.prompts.length, 0);
	});
});

describe("graded exercises (REQ-lec-16, 17)", () => {
	async function setup(trust?: Record<string, TrustLevel>) {
		const h = harness({
			trust,
			generated: [[exercise({ nodeIds: ["n_a", "n_c"], steps: [
				{ id: "s1", text: "Write each number as twice an integer.", nodeIds: ["n_a"] },
				{ id: "s2", text: "Add them and factor out the two.", nodeIds: ["n_c"] },
			] })]],
		});
		const { setId } = await h.svc.createExerciseSet({ goalId: "goal_1" });
		const sess = h.svc.startExercise({ setId, exerciseId: "ex1" });
		return { h, setId, sess };
	}
	const both = [item("s1", "Write each number as twice an integer", "Let a = 2k and b = 2m"), item("s2", "Add them and factor out the two", "Then a + b = 2(k + m)")];

	it("designates the reference solution and grades by node", async () => {
		const { h, sess } = await setup();
		assert.match(h.svc.sourceOf(sess.chatId)!.text, /\[s1\] Write each number/);
		h.svc.submitVerdict(sess.chatId, both, WORK);
		const g = h.ex.find((e) => e.type === "graded");
		assert.equal(g?.type === "graded" && g.outcome, "consistent");
		assert.deepEqual(g?.type === "graded" && g.nodeOutcomes.map((o) => o.outcome), ["passed", "passed"]);
	});
	it("applies the results to the personal layer once, when the set is complete", async () => {
		const { h, sess } = await setup();
		const r = h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.equal(h.applied.length, 1);
		assert.match(r.text, /goal is reached/);
		h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.equal(h.applied.length, 1);
	});
	it("an unverifiable verdict is not recorded as a grading and keeps an earlier one", async () => {
		const { h, sess } = await setup();
		h.svc.submitVerdict(sess.chatId, [item("s1", "an entirely invented passage of the source", "Let a")], WORK);
		assert.equal(h.ex.filter((e) => e.type === "graded").length, 0);
		h.svc.submitVerdict(sess.chatId, both, WORK);
		h.svc.submitVerdict(sess.chatId, [item("s1", "an entirely invented passage of the source", "Let a")], WORK);
		const graded = h.ex.filter((e) => e.type === "graded");
		assert.equal(graded.length, 1);
		assert.equal(graded[0]?.type === "graded" && graded[0].outcome, "consistent");
	});
	it("reports the outcome and says dropped items were not found or too short", async () => {
		const { h, sess } = await setup();
		const r = h.svc.submitVerdict(sess.chatId, [item("s1", "an entirely invented passage of the source", "Let a")], WORK);
		assert.equal(r.outcome, "not_verifiable");
		assert.match(r.text, /were not found or were too short/);
	});
	it("does not apply an unverifiable grading", async () => {
		const { h, sess } = await setup();
		h.svc.submitVerdict(sess.chatId, [item("s1", "an entirely invented passage of the source", "Let a")], WORK);
		assert.equal(h.applied.length, 0);
	});
	it("withholds passes resting on unverified nodes (low confidence) and says so", async () => {
		const { h, sess } = await setup({ n_c: "unverified" });
		const r = h.svc.submitVerdict(sess.chatId, both, WORK);
		assert.match(r.text, /Low confidence/);
		assert.equal(h.applied.length, 0, "all passes withheld: nothing to apply");
	});
	it("a differing step reopens its nodes through the personal layer", async () => {
		const { h, sess } = await setup();
		h.svc.submitVerdict(sess.chatId, [both[0]!, item("s2", "Add them and factor out the two", "Then a + b = 2(k + m)", "differs")], WORK);
		const byNode = Object.fromEntries(h.applied[0]!.results.map((r) => [r.nodeId, r.outcome]));
		assert.deepEqual(byNode, { n_a: "passed", n_c: "failed" });
	});
});
