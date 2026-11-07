// src/agent/ext/practice/exercise-writer.ts
/**
 * Generates an exercise set for a goal (REQ-lec-15): one schema-validated
 * submission through the lecture stage's runStructured seam, so it is gated
 * by the shared daily cost ceiling. Semantic rules (validateExerciseSet) are
 * checked by the caller, which retries with the violations as feedback.
 */

import { Type } from "typebox";
import type { Exercise } from "../../../core/ext/practice/exercises.ts";
import type { WriterDeps } from "../lecture/writers.ts";
import { runStructured } from "../lecture/structured.ts";

export interface ExerciseNode {
	id: string;
	name: string;
	statement: string;
}

export interface ExerciseWriteInput {
	goalTitle: string;
	/** The goal's scope nodes. */
	nodes: readonly ExerciseNode[];
	targetNodeIds: readonly string[];
	count: number;
	feedback: string | null;
	/** The learner's study preferences for these nodes (session notes), already formatted; "" when none. */
	studyNotes?: string;
}

export const EXERCISE_SYSTEM = `You write graded exercises for a learner studying a knowledge graph toward a goal. Submit them with the submit_exercises tool.

An exercise makes the learner APPLY several nodes together to solve a small problem: a proof, a computation, a counterexample. It is never a recall question: do not copy a node statement into a prompt, and do not ask "state" or "define".

Each exercise carries its REFERENCE SOLUTION as steps. A step is one sentence or formula of the solution, at least 20 characters, written exactly as a solutions manual would write it, and it lists the node ids whose content the step uses. The reference solution is what the learner's work will be compared with, so it must be correct, complete and use only the given nodes' content.

Rules: use only node ids from the list; every exercise combines at least 2 distinct nodes; together the exercises cover every target node; exercise ids are ex1, ex2, ...; step ids are s1, s2, ... within an exercise.`;

export function exercisePrompt(input: ExerciseWriteInput): string {
	const nodes = input.nodes.map((n) => `- ${n.id} (${n.name}): ${n.statement}`).join("\n");
	return [
		...(input.studyNotes ? [input.studyNotes, ""] : []),
		`Goal: ${input.goalTitle}`,
		`Target nodes: ${input.targetNodeIds.join(", ")}`,
		`Write ${input.count} exercises over these nodes:`,
		nodes,
		...(input.feedback !== null ? ["", "Your previous attempt was rejected for these reasons; fix them:", input.feedback] : []),
	].join("\n");
}

const ExerciseSchema = Type.Object({
	exercises: Type.Array(
		Type.Object({
			id: Type.String(),
			prompt: Type.String(),
			nodeIds: Type.Array(Type.String(), { minItems: 2 }),
			steps: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), nodeIds: Type.Array(Type.String(), { minItems: 1 }) }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

export async function writeExerciseSet(deps: WriterDeps, input: ExerciseWriteInput): Promise<Exercise[]> {
	const out = await runStructured<{ exercises: Exercise[] }>({
		...deps,
		costSource: "exercises",
		role: "teacher",
		toolName: "submit_exercises",
		toolDescription: "Submit the exercise set with reference solutions.",
		parameters: ExerciseSchema,
		systemPrompt: EXERCISE_SYSTEM,
		prompt: exercisePrompt(input),
	});
	return out.exercises;
}
