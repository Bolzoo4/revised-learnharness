// src/core/ext/practice/exercises.ts
/**
 * Graded exercises (REQ-lec-15, 16, 17). An exercise set belongs to a goal and
 * is built over nodes of the goal's scope. Each exercise carries its reference
 * solution as steps, each step citing the nodes it uses. Grading compares the
 * student's work with that reference through verdict.ts; a node's outcome is
 * derived from the steps that cite it.
 */

import { normalizeForMatch, MIN_QUOTE_CHARS } from "../quote.ts";
import type { TrustLevel } from "../trust.ts";
import type { VerdictItem } from "./verdict.ts";

export interface ExerciseStep {
	id: string;
	text: string;
	nodeIds: string[];
}
export interface Exercise {
	id: string;
	prompt: string;
	/** The nodes the exercise combines. */
	nodeIds: string[];
	/** The reference solution. */
	steps: ExerciseStep[];
}
export type NodeOutcome = "passed" | "weak" | "failed";

export interface ExerciseSetContext {
	/** The goal's scope (targets plus premise closure). */
	scope: ReadonlySet<string>;
	targetNodeIds: readonly string[];
	statements: ReadonlyMap<string, string>;
}

/** Every rule violation of a generated set, empty = accepted. */
export function validateExerciseSet(exercises: readonly Exercise[], ctx: ExerciseSetContext): string[] {
	const errors: string[] = [];
	if (exercises.length === 0) errors.push("the set has no exercises");
	const ids = new Set<string>();
	const covered = new Set<string>();
	for (const ex of exercises) {
		if (ids.has(ex.id)) errors.push(`duplicate exercise id ${ex.id}`);
		ids.add(ex.id);
		if (ex.prompt.trim() === "") errors.push(`exercise ${ex.id} has an empty prompt`);
		const distinct = new Set(ex.nodeIds);
		if (distinct.size < 2) errors.push(`exercise ${ex.id} must combine at least 2 nodes (a single-fact recall question is not an exercise)`);
		for (const id of distinct) {
			covered.add(id);
			if (!ctx.scope.has(id)) errors.push(`exercise ${ex.id} uses node ${id}, which is outside the goal's scope`);
		}
		const prompt = normalizeForMatch(ex.prompt, "join");
		for (const id of distinct) {
			const statement = normalizeForMatch(ctx.statements.get(id) ?? "", "join");
			if (statement.length >= 40 && prompt.includes(statement)) errors.push(`exercise ${ex.id} states the full statement of ${id} in its prompt: ask for an application, not a recall`);
		}
		if (ex.steps.length === 0) errors.push(`exercise ${ex.id} has no reference solution steps`);
		const stepIds = new Set<string>();
		for (const s of ex.steps) {
			if (stepIds.has(s.id)) errors.push(`exercise ${ex.id} repeats step id ${s.id}`);
			stepIds.add(s.id);
			if (s.text.trim().length < MIN_QUOTE_CHARS) errors.push(`exercise ${ex.id} step ${s.id} is shorter than ${MIN_QUOTE_CHARS} characters (it must be quotable)`);
			if (s.nodeIds.length === 0) errors.push(`exercise ${ex.id} step ${s.id} cites no node`);
			for (const id of s.nodeIds) if (!ctx.scope.has(id)) errors.push(`exercise ${ex.id} step ${s.id} cites node ${id}, outside the goal's scope`);
		}
	}
	for (const t of ctx.targetNodeIds) if (!covered.has(t)) errors.push(`no exercise covers the goal's target node ${t}`);
	return [...new Set(errors)];
}

/** The text the student's work is compared with: one line per step, prefixed by its id. */
export function referenceText(ex: Exercise): string {
	return ex.steps.map((s) => `[${s.id}] ${s.text}`).join("\n");
}

/** Every node the reference solution relies on. */
export function nodesUsed(ex: Exercise): string[] {
	return [...new Set([...ex.nodeIds, ...ex.steps.flatMap((s) => s.nodeIds)])];
}

/** REQ-lec-16: the grading is low confidence when the reference uses any node whose trust is not `sourced`. */
export function isLowConfidence(ex: Exercise, trust: ReadonlyMap<string, TrustLevel>): boolean {
	return nodesUsed(ex).some((id) => (trust.get(id) ?? "unverified") !== "sourced");
}

/** Per-node outcomes of one graded exercise: a step is good when its surviving items all match, bad when any differs or is missing, unknown without items. */
export function nodeOutcomes(ex: Exercise, kept: readonly VerdictItem[]): Array<{ nodeId: string; outcome: NodeOutcome }> {
	const stepStatus = new Map<string, "good" | "bad">();
	for (const s of ex.steps) {
		const items = kept.filter((i) => i.stepRef === s.id);
		if (items.length === 0) continue;
		stepStatus.set(s.id, items.every((i) => i.stance === "matches") ? "good" : "bad");
	}
	const out: Array<{ nodeId: string; outcome: NodeOutcome }> = [];
	for (const nodeId of nodesUsed(ex)) {
		const known = ex.steps.filter((s) => s.nodeIds.includes(nodeId) && stepStatus.has(s.id)).map((s) => stepStatus.get(s.id)!);
		if (known.length === 0) continue;
		const good = known.filter((k) => k === "good").length;
		out.push({ nodeId, outcome: good === known.length ? "passed" : good === 0 ? "failed" : "weak" });
	}
	return out;
}

// ── ledger events ───────────────────────────────────────────────────────────

export type ExerciseEvent =
	| { type: "set_created"; setId: string; goalId: string; exercises: Exercise[]; at: string }
	| {
			type: "graded";
			setId: string;
			exerciseId: string;
			outcome: "consistent" | "differs" | "not_verifiable";
			nodeOutcomes: Array<{ nodeId: string; outcome: NodeOutcome }>;
			lowConfidence: boolean;
			at: string;
	  }
	| { type: "applied"; setId: string; reached: boolean; at: string };

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const OUTCOMES = new Set<string>(["passed", "weak", "failed"]);
const VERDICTS = new Set<string>(["consistent", "differs", "not_verifiable"]);

function parseExercise(raw: unknown): Exercise | null {
	if (!isObj(raw) || !isStr(raw.id) || typeof raw.prompt !== "string") return null;
	if (!Array.isArray(raw.nodeIds) || !raw.nodeIds.every(isStr) || !Array.isArray(raw.steps)) return null;
	const steps: ExerciseStep[] = [];
	for (const s of raw.steps) {
		if (!isObj(s) || !isStr(s.id) || typeof s.text !== "string" || !Array.isArray(s.nodeIds) || !s.nodeIds.every(isStr)) return null;
		steps.push({ id: s.id, text: s.text, nodeIds: [...s.nodeIds] });
	}
	return { id: raw.id, prompt: raw.prompt, nodeIds: [...raw.nodeIds], steps };
}

export function parseExerciseEvent(raw: unknown): ExerciseEvent | null {
	if (!isObj(raw) || !isStr(raw.setId) || !isStr(raw.at)) return null;
	if (raw.type === "applied") return typeof raw.reached === "boolean" ? { type: "applied", setId: raw.setId, reached: raw.reached, at: raw.at } : null;
	if (raw.type === "graded") {
		if (!isStr(raw.exerciseId) || !isStr(raw.outcome) || !VERDICTS.has(raw.outcome) || typeof raw.lowConfidence !== "boolean" || !Array.isArray(raw.nodeOutcomes)) return null;
		const outcomes: Array<{ nodeId: string; outcome: NodeOutcome }> = [];
		for (const o of raw.nodeOutcomes) {
			if (!isObj(o) || !isStr(o.nodeId) || !isStr(o.outcome) || !OUTCOMES.has(o.outcome)) return null;
			outcomes.push({ nodeId: o.nodeId, outcome: o.outcome as NodeOutcome });
		}
		return { type: "graded", setId: raw.setId, exerciseId: raw.exerciseId, outcome: raw.outcome as "consistent" | "differs" | "not_verifiable", nodeOutcomes: outcomes, lowConfidence: raw.lowConfidence, at: raw.at };
	}
	if (raw.type === "set_created") {
		if (!isStr(raw.goalId) || !Array.isArray(raw.exercises) || raw.exercises.length === 0) return null;
		const exercises: Exercise[] = [];
		for (const e of raw.exercises) {
			const parsed = parseExercise(e);
			if (parsed === null) return null;
			exercises.push(parsed);
		}
		return { type: "set_created", setId: raw.setId, goalId: raw.goalId, exercises, at: raw.at };
	}
	return null;
}

export interface ExerciseSetState {
	setId: string;
	goalId: string;
	exercises: Exercise[];
	createdAt: string;
	/** Latest grading per exercise id. */
	graded: Map<string, Extract<ExerciseEvent, { type: "graded" }>>;
	applied: { reached: boolean } | null;
}

export function deriveExerciseSets(events: readonly ExerciseEvent[]): ExerciseSetState[] {
	const sets = new Map<string, ExerciseSetState>();
	for (const e of events) {
		if (e.type === "set_created") {
			if (!sets.has(e.setId)) sets.set(e.setId, { setId: e.setId, goalId: e.goalId, exercises: e.exercises, createdAt: e.at, graded: new Map(), applied: null });
			continue;
		}
		const s = sets.get(e.setId);
		if (s === undefined) continue;
		if (e.type === "graded") {
			if (s.exercises.some((x) => x.id === e.exerciseId)) s.graded.set(e.exerciseId, e);
		} else if (s.applied === null) s.applied = { reached: e.reached };
	}
	return [...sets.values()];
}

/** Every exercise has a latest grading that could be verified. */
export function setComplete(set: ExerciseSetState): boolean {
	return set.exercises.every((x) => {
		const g = set.graded.get(x.id);
		return g !== undefined && g.outcome !== "not_verifiable";
	});
}

/**
 * The results handed to the personal layer when a set is complete. Per node the
 * worst outcome across exercises wins. Passed outcomes of LOW-CONFIDENCE
 * gradings are withheld (a pass resting on unverified nodes does not advance a
 * goal); their weak and failed outcomes still count, since they only reopen a node.
 */
export function setResults(set: ExerciseSetState): Array<{ nodeId: string; outcome: NodeOutcome }> {
	const rank: Record<NodeOutcome, number> = { passed: 0, weak: 1, failed: 2 };
	const worst = new Map<string, NodeOutcome>();
	for (const g of set.graded.values()) {
		for (const o of g.nodeOutcomes) {
			if (g.lowConfidence && o.outcome === "passed") continue;
			const prev = worst.get(o.nodeId);
			if (prev === undefined || rank[o.outcome] > rank[prev]) worst.set(o.nodeId, o.outcome);
		}
	}
	return [...worst.entries()].map(([nodeId, outcome]) => ({ nodeId, outcome }));
}
