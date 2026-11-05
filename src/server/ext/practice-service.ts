// src/server/ext/practice-service.ts
/**
 * Office hours and graded exercises (REQ-lec-12 to 17). Everything impure is
 * injected; the live wiring is practice-live.ts.
 *
 * A session is a chat of kind `office_hours` plus a "designated" event that
 * pins the text its work is compared with. A verdict is computed by code
 * (verdict.ts) from the items the model proposed; when the session grades an
 * exercise, the per-node outcomes are derived by code and, once every
 * exercise of the set has a verifiable grading, handed to the personal layer
 * through applyExerciseResult (the only writer of a goal's `reached`).
 */

import { randomBytes } from "node:crypto";
import type { OfficeHoursToolContext, VerdictReport } from "../../agent/ext/practice/office-hours-tools.ts";
import type { ExerciseNode, ExerciseWriteInput } from "../../agent/ext/practice/exercise-writer.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { generateWithFeedback } from "../../core/ext/lecture/retry.ts";
import {
	deriveExerciseSets,
	isLowConfidence,
	nodeOutcomes,
	referenceText,
	setComplete,
	setResults,
	validateExerciseSet,
	type Exercise,
	type ExerciseEvent,
	type ExerciseSetState,
	type NodeOutcome,
} from "../../core/ext/practice/exercises.ts";
import { designationOf, type OfficeHoursEvent } from "../../core/ext/practice/office-hours.ts";
import { checkVerdictItems, OUTCOME_TEXT, verdictOutcome, type VerdictItem } from "../../core/ext/practice/verdict.ts";
import type { SnapshotStore } from "../../core/ext/ports.ts";
import type { TrustLevel } from "../../core/ext/trust.ts";
import type { SnapshotReader } from "../../core/ext/study-ports.ts";
import { HttpError } from "./http-error.ts";

export const MAX_EXERCISE_RETRIES = 2;
export const DEFAULT_EXERCISE_COUNT = 3;
const MAX_SOURCE_TEXT_CHARS = 200_000;

export class PracticeError extends HttpError {}

interface LedgerLike<T> {
	append(event: T): void;
	readAll(): T[];
}

export interface PracticeServiceDeps {
	officeHours: LedgerLike<OfficeHoursEvent>;
	exercises: LedgerLike<ExerciseEvent>;
	snapshots: SnapshotStore & SnapshotReader;
	gate: CostGate;
	/** Creates an `office_hours` chat. */
	createSession(title: string): { id: string };
	/** The goal's targets and scope, or null for an unknown or inactive goal. */
	goalScope(goalId: string): { title: string; targetNodeIds: string[]; scope: string[]; status: string } | null;
	nodes(ids: readonly string[]): ExerciseNode[];
	trust(nodeIds: readonly string[]): Map<string, TrustLevel>;
	writeExerciseSet(input: ExerciseWriteInput): Promise<Exercise[]>;
	/** The personal layer's applyExerciseResult. */
	applyExerciseResult(input: { goalId: string; results: Array<{ nodeId: string; outcome: NodeOutcome }> }): { reached: boolean };
	now?: () => string;
	newId?: () => string;
}

export interface SessionView {
	chatId: string;
	label: string;
	exercise?: { setId: string; exerciseId: string };
}

export function createPracticeService(deps: PracticeServiceDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	const newId = deps.newId ?? (() => randomBytes(5).toString("hex"));

	function sets(): ExerciseSetState[] {
		return deriveExerciseSets(deps.exercises.readAll());
	}
	function setById(setId: string): ExerciseSetState {
		const s = sets().find((x) => x.setId === setId);
		if (s === undefined) throw new PracticeError(404, "unknown exercise set");
		return s;
	}

	function designate(chatId: string, label: string, text: string, exercise?: { setId: string; exerciseId: string }): void {
		const sha256 = deps.snapshots.put(text);
		deps.officeHours.append({ type: "designated", chatId, label, sha256, ...(exercise ? { exercise } : {}), at: now() });
	}

	/** REQ-lec-12: a free office-hours session on a pasted source (solutions manual passage, textbook proof). */
	function startSession(input: { label: string; sourceText?: string }): SessionView {
		const label = input.label.trim();
		if (label === "") throw new PracticeError(400, "label is required");
		const text = input.sourceText?.trim() ?? "";
		if (text.length > MAX_SOURCE_TEXT_CHARS) throw new PracticeError(400, "the source text is too long");
		const chat = deps.createSession(`Office hours: ${label}`);
		if (text !== "") designate(chat.id, label, text);
		return { chatId: chat.id, label };
	}

	/** REQ-lec-16: a session that grades one exercise; its designated source is the exercise's reference solution. */
	function startExercise(input: { setId: string; exerciseId: string }): SessionView {
		const set = setById(input.setId);
		const ex = set.exercises.find((e) => e.id === input.exerciseId);
		if (ex === undefined) throw new PracticeError(404, "unknown exercise");
		const label = `Exercise ${ex.id}: reference solution`;
		const chat = deps.createSession(`Exercise: ${ex.prompt.slice(0, 60)}`);
		const link = { setId: set.setId, exerciseId: ex.id };
		designate(chat.id, label, referenceText(ex), link);
		return { chatId: chat.id, label, exercise: link };
	}

	function sourceOf(chatId: string): { label: string; text: string } | null {
		const d = designationOf(deps.officeHours.readAll(), chatId);
		if (d === null) return null;
		const text = deps.snapshots.get(d.sha256);
		return text === null ? null : { label: d.label, text };
	}

	/** REQ-lec-13 / 14 / 16: code decides the verdict; an exercise session also records the grading. */
	function submitVerdict(chatId: string, items: VerdictItem[], work: string): VerdictReport {
		const d = designationOf(deps.officeHours.readAll(), chatId);
		const source = d === null ? null : sourceOf(chatId);
		if (d === null || source === null) throw new PracticeError(409, "no source is designated for this session: no verdict is possible");
		if (work.trim() === "") throw new PracticeError(409, "the learner has not written any work yet");
		const { kept, discarded } = checkVerdictItems(items, source.text, work);
		const outcome = verdictOutcome(kept);
		const at = now();
		deps.officeHours.append({ type: "verdict", chatId, outcome, items: kept, discarded: discarded.length, at });

		const lines = [OUTCOME_TEXT[outcome]];
		for (const i of kept) {
			if (i.stance === "matches") continue;
			const where = i.stance === "differs" ? `the work says "${i.workQuote}"` : "the work has nothing for this step";
			lines.push(`- ${i.stepRef}: the source says "${i.sourceQuote}"; ${where}.`);
		}
		if (discarded.length > 0) lines.push(`${discarded.length} comparison(s) were dropped because their quotations were not found in the texts.`);

		if (d.exercise !== undefined) {
			const set = setById(d.exercise.setId);
			const ex = set.exercises.find((e) => e.id === d.exercise!.exerciseId);
			if (ex !== undefined) {
				const low = isLowConfidence(ex, deps.trust([...new Set([...ex.nodeIds, ...ex.steps.flatMap((s) => s.nodeIds)])]));
				deps.exercises.append({
					type: "graded",
					setId: set.setId,
					exerciseId: ex.id,
					outcome,
					nodeOutcomes: nodeOutcomes(ex, kept),
					lowConfidence: low,
					at,
				});
				if (low) lines.push("Low confidence: the reference solution relies on nodes that are not verified against a source.");
				const applied = applyIfComplete(set.setId);
				if (applied !== null) lines.push(applied.reached ? "Exercise set complete: the goal is reached." : "Exercise set complete: the review schedule was updated; the goal is not reached yet.");
			}
		}
		return { text: lines.join("\n") };
	}

	/** When every exercise has a verifiable grading, hands the results to the personal layer, once. */
	function applyIfComplete(setId: string): { reached: boolean } | null {
		const set = setById(setId);
		if (set.applied !== null || !setComplete(set)) return null;
		const results = setResults(set);
		if (results.length === 0) return null;
		const res = deps.applyExerciseResult({ goalId: set.goalId, results });
		deps.exercises.append({ type: "applied", setId, reached: res.reached, at: now() });
		return res;
	}

	/** REQ-lec-15: generate, validate in code, retry with the violations as feedback. */
	async function createExerciseSet(input: { goalId: string; count?: number }): Promise<{ setId: string }> {
		const goal = deps.goalScope(input.goalId);
		if (goal === null || goal.status !== "active") throw new PracticeError(404, "unknown or inactive goal");
		if (!deps.gate.allowed()) throw new PracticeError(429, "the daily ceiling for background model work is spent");
		const nodes = deps.nodes(goal.scope);
		const ctx = { scope: new Set(goal.scope), targetNodeIds: goal.targetNodeIds, statements: new Map(nodes.map((n) => [n.id, n.statement] as const)) };
		const count = Math.max(1, Math.min(input.count ?? DEFAULT_EXERCISE_COUNT, 8));
		const run = await generateWithFeedback({
			attempt: (feedback) => deps.writeExerciseSet({ goalTitle: goal.title, nodes, targetNodeIds: goal.targetNodeIds, count, feedback }),
			validate: (v) => validateExerciseSet(v, ctx),
			feedback: (errors) => errors.map((e) => `- ${e}`).join("\n"),
			maxRetries: MAX_EXERCISE_RETRIES,
		});
		if (!run.ok) throw new PracticeError(422, `the generated exercises were rejected: ${run.errors.join("; ")}`);
		const setId = `set_${newId()}`;
		deps.exercises.append({ type: "set_created", setId, goalId: input.goalId, exercises: run.value, at: now() });
		return { setId };
	}

	function toolContext(chatId: string, chatStore: OfficeHoursToolContext["chatStore"]): OfficeHoursToolContext {
		return { chatId, chatStore, source: () => sourceOf(chatId), submitVerdict: (items, work) => submitVerdict(chatId, items, work) };
	}

	return {
		startSession,
		startExercise,
		submitVerdict,
		createExerciseSet,
		sourceOf,
		toolContext,
		listSets: (goalId?: string): ExerciseSetState[] => sets().filter((s) => goalId === undefined || s.goalId === goalId),
		getSet: setById,
		/** Verdicts given in a session, newest last. */
		verdictsOf: (chatId: string) => deps.officeHours.readAll().filter((e) => e.type === "verdict" && e.chatId === chatId),
	};
}

export type PracticeService = ReturnType<typeof createPracticeService>;
