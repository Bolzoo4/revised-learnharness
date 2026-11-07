"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Exercise, ExamDoc } from "./exams-types.ts";
import { editExercise, listExercises, markReviewed, startPractice, type ExerciseOp } from "./exams-api.ts";
import { canMergeWithNext, pageSpan, practiceEnabled, splitChoice } from "./exams-logic.ts";

const EMPTY_TEXT = "The exercise text cannot be empty.";

/**
 * The review list of one exam (REQ-ex-03): the exercises in order, each with its page span and text, and the
 * edits that shape them (merge with next, split at the text cursor, delete, edit). Practice on an exercise opens
 * only after the exam is marked as reviewed. The container loads and saves; ExerciseCards only shows and reports.
 */
export function ExamReview({ collectionId, exam, onExamChanged }: { collectionId: string; exam: ExamDoc; onExamChanged: (exam: ExamDoc) => void }) {
	const router = useRouter();
	const [exercises, setExercises] = useState<Exercise[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let alive = true;
		setExercises(null);
		setError(null);
		void listExercises(fetch, exam.id).then((r) => {
			if (!alive) return;
			if (r.ok) setExercises(r.value);
			else setError(r.error);
		});
		return () => {
			alive = false;
		};
	}, [exam.id]);

	/** One edit; resolves true when the server took it, so the card can leave its edit mode. */
	async function apply(op: ExerciseOp): Promise<boolean> {
		setBusy(true);
		setError(null);
		const r = await editExercise(fetch, exam.id, op);
		setBusy(false);
		if (r.ok) {
			setExercises(r.value);
			return true;
		}
		setError(r.error);
		return false;
	}

	async function review() {
		setBusy(true);
		setError(null);
		const r = await markReviewed(fetch, exam.id);
		setBusy(false);
		if (r.ok) onExamChanged(r.value);
		else setError(r.error);
	}

	async function practice(exerciseId: string) {
		setBusy(true);
		setError(null);
		const r = await startPractice(fetch, collectionId, exerciseId);
		if (r.ok) router.push(`/chat/${r.value.chatId}`);
		else {
			setBusy(false);
			setError(r.error);
		}
	}

	if (exercises === null) {
		return error !== null ? <p className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">Loading the exercises…</p>;
	}

	return (
		<ExerciseCards
			exercises={exercises}
			reviewed={exam.reviewed}
			busy={busy}
			error={error}
			onOp={apply}
			onPractice={(id) => void practice(id)}
			onMarkReviewed={() => void review()}
		/>
	);
}

/** The exercise list and its controls. Presentational: the callbacks carry every change to the container. */
export function ExerciseCards({
	exercises,
	reviewed,
	busy,
	error,
	onOp,
	onPractice,
	onMarkReviewed,
}: {
	exercises: Exercise[];
	reviewed: boolean;
	busy: boolean;
	error: string | null;
	onOp: (op: ExerciseOp) => Promise<boolean>;
	onPractice: (exerciseId: string) => void;
	onMarkReviewed: () => void;
}) {
	return (
		<section className="flex flex-col gap-3" aria-label="Exercises of this exam">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium">{exercises.length === 1 ? "1 exercise" : `${exercises.length} exercises`}</h3>
				{reviewed ? (
					<p className="text-sm text-muted-foreground">Reviewed</p>
				) : (
					<button type="button" className="rounded border px-3 py-1 text-sm" disabled={busy} onClick={onMarkReviewed}>
						Mark as reviewed
					</button>
				)}
			</div>
			{!reviewed ? <p className="text-sm text-muted-foreground">Check the split and the text. Practice opens when you mark the exam as reviewed.</p> : null}
			{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
			{exercises.length === 0 ? (
				<p className="text-sm text-muted-foreground">No exercises were found in this exam.</p>
			) : (
				<ol className="flex flex-col gap-3">
					{exercises.map((exercise, index) => (
						<ExerciseCard
							key={exercise.id}
							exercise={exercise}
							index={index}
							count={exercises.length}
							reviewed={reviewed}
							busy={busy}
							onOp={onOp}
							onPractice={onPractice}
						/>
					))}
				</ol>
			)}
		</section>
	);
}

function ExerciseCard({
	exercise,
	index,
	count,
	reviewed,
	busy,
	onOp,
	onPractice,
}: {
	exercise: Exercise;
	index: number;
	count: number;
	reviewed: boolean;
	busy: boolean;
	onOp: (op: ExerciseOp) => Promise<boolean>;
	onPractice: (exerciseId: string) => void;
}) {
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(exercise.text);
	const [note, setNote] = useState<string | null>(null);

	/** The cut is the text cursor (selectionStart) in the exercise text, checked by splitChoice. */
	async function splitHere() {
		const choice = splitChoice(exercise.text, textRef.current ? textRef.current.selectionStart : null);
		if (!choice.ok) {
			setNote(choice.error);
			return;
		}
		setNote(null);
		await onOp({ op: "split", id: exercise.id, at: choice.at });
	}

	async function save() {
		if (draft.trim() === "") {
			setNote(EMPTY_TEXT);
			return;
		}
		setNote(null);
		if (await onOp({ op: "edit", id: exercise.id, text: draft })) setEditing(false);
	}

	return (
		<li className="flex flex-col gap-2 rounded border p-3">
			<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">Exercise {index + 1}</span>
				<span className="text-muted-foreground">{pageSpan(exercise)}</span>
			</div>
			<label className="flex flex-col gap-1 text-sm">
				<span className="sr-only">Text of exercise {index + 1}</span>
				<textarea
					ref={textRef}
					className="w-full rounded border bg-transparent px-2 py-1 text-sm"
					rows={6}
					readOnly={!editing}
					value={editing ? draft : exercise.text}
					onChange={(e) => setDraft(e.target.value)}
				/>
			</label>
			{note !== null ? <p className="text-sm text-destructive">{note}</p> : null}
			<div className="flex flex-wrap gap-2 text-sm">
				{editing ? (
					<>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void save()}>
							Save
						</button>
						<button
							type="button"
							className="rounded border px-2 py-1"
							disabled={busy}
							onClick={() => {
								setEditing(false);
								setDraft(exercise.text);
								setNote(null);
							}}
						>
							Cancel
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className="rounded border px-2 py-1"
							disabled={busy || !canMergeWithNext(index, count)}
							onClick={() => void onOp({ op: "merge", firstId: exercise.id })}
						>
							Merge with next
						</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void splitHere()}>
							Split here
						</button>
						<button
							type="button"
							className="rounded border px-2 py-1"
							disabled={busy}
							onClick={() => {
								setDraft(exercise.text);
								setNote(null);
								setEditing(true);
							}}
						>
							Edit
						</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void onOp({ op: "delete", id: exercise.id })}>
							Delete
						</button>
					</>
				)}
				<button
					type="button"
					className="rounded border px-2 py-1"
					disabled={busy || editing || !practiceEnabled(reviewed)}
					title={practiceEnabled(reviewed) ? undefined : "Mark the exam as reviewed to practise"}
					onClick={() => onPractice(exercise.id)}
				>
					Practice
				</button>
			</div>
		</li>
	);
}
