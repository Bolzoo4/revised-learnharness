// src/core/ext/exams/exercises.ts
/**
 * The learner's edits of an exam's exercise list (REQ-ex-03), as pure functions:
 * merge two consecutive exercises, split one at a character offset, delete one,
 * edit one's text. Every result is renumbered 1..n in order. A merge or a split
 * changes the text a solution belongs to, so both drop the solution and its
 * origin; an edit keeps them (the text changed, not the exercise's boundaries).
 */

import type { Exercise } from "./types.ts";
import { MAX_EXERCISE_CHARS } from "./bounds.ts";

export type ExerciseOp =
	| { op: "merge"; firstId: string }
	| { op: "split"; id: string; at: number }
	| { op: "delete"; id: string }
	| { op: "edit"; id: string; text: string };

/** A refused edit. The message is fixed text written here, safe to show. */
export class ExerciseEditError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function idOf(v: unknown): string {
	if (typeof v !== "string" || !ID_RE.test(v)) throw new ExerciseEditError("exercise id is not valid");
	return v;
}

function textOf(v: unknown): string {
	if (typeof v !== "string") throw new ExerciseEditError("exercise text must be text");
	const trimmed = v.trim();
	if (trimmed === "") throw new ExerciseEditError("exercise text is empty");
	if (trimmed.length > MAX_EXERCISE_CHARS) throw new ExerciseEditError(`exercise text is too long (at most ${MAX_EXERCISE_CHARS} characters)`);
	return trimmed;
}

/** Checks the shape of an op from a request body. Throws ExerciseEditError with a fixed message. */
export function parseExerciseOp(raw: unknown): ExerciseOp {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ExerciseEditError("the edit must be an object");
	const r = raw as Record<string, unknown>;
	switch (r.op) {
		case "merge":
			return { op: "merge", firstId: idOf(r.firstId) };
		case "split": {
			if (typeof r.at !== "number" || !Number.isInteger(r.at)) throw new ExerciseEditError("split position must be a whole number");
			return { op: "split", id: idOf(r.id), at: r.at };
		}
		case "delete":
			return { op: "delete", id: idOf(r.id) };
		case "edit":
			return { op: "edit", id: idOf(r.id), text: textOf(r.text) };
		default:
			throw new ExerciseEditError("unknown edit operation");
	}
}

/** The exercises in order, numbered 1..n. */
export function renumber(exercises: readonly Exercise[]): Exercise[] {
	return exercises.map((e, i) => ({ ...e, order: i + 1 }));
}

function indexOfId(list: readonly Exercise[], id: string): number {
	const i = list.findIndex((e) => e.id === id);
	if (i < 0) throw new ExerciseEditError("no exercise has that id");
	return i;
}

/** Applies one edit and returns the new list. `newId` names the second half of a split. The input is not changed. */
export function applyExerciseOp(exercises: readonly Exercise[], op: ExerciseOp, newId: () => string): Exercise[] {
	const list = [...exercises].sort((a, b) => a.order - b.order);
	switch (op.op) {
		case "merge": {
			const i = indexOfId(list, op.firstId);
			const first = list[i]!;
			const next = list[i + 1];
			if (next === undefined) throw new ExerciseEditError("there is no next exercise to merge with");
			const text = `${first.text}\n\n${next.text}`;
			if (text.length > MAX_EXERCISE_CHARS) throw new ExerciseEditError("the merged exercise would be too long");
			const merged: Exercise = {
				id: first.id,
				examId: first.examId,
				order: first.order,
				pageStart: Math.min(first.pageStart, next.pageStart),
				pageEnd: Math.max(first.pageEnd, next.pageEnd),
				text,
			};
			return renumber([...list.slice(0, i), merged, ...list.slice(i + 2)]);
		}
		case "split": {
			const i = indexOfId(list, op.id);
			const cur = list[i]!;
			if (op.at <= 0 || op.at >= cur.text.length) throw new ExerciseEditError("split position is outside the text");
			const left = cur.text.slice(0, op.at).trim();
			const right = cur.text.slice(op.at).trim();
			if (left === "" || right === "") throw new ExerciseEditError("a split must leave text on both sides");
			const base = { examId: cur.examId, pageStart: cur.pageStart, pageEnd: cur.pageEnd };
			const a: Exercise = { id: cur.id, order: cur.order, text: left, ...base };
			const b: Exercise = { id: newId(), order: cur.order + 1, text: right, ...base };
			return renumber([...list.slice(0, i), a, b, ...list.slice(i + 1)]);
		}
		case "delete": {
			const i = indexOfId(list, op.id);
			return renumber([...list.slice(0, i), ...list.slice(i + 1)]);
		}
		case "edit": {
			const i = indexOfId(list, op.id);
			const text = textOf(op.text);
			return renumber(list.map((e, j) => (j === i ? { ...e, text } : e)));
		}
	}
}
