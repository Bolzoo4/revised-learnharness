"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ExerciseRow { id: string; prompt: string; graded: { outcome: string; lowConfidence: boolean } | null }
interface SetRow { setId: string; goalId: string; exercises: ExerciseRow[]; applied: { reached: boolean } | null }

/** Practice page: office hours on a pasted source (REQ-lec-12) and graded exercise sets (REQ-lec-15 to 17). */
export function PracticePanel({ goals }: { goals: Array<{ id: string; title: string }> }) {
	const router = useRouter();
	const [label, setLabel] = useState("");
	const [sourceText, setSourceText] = useState("");
	const [goalId, setGoalId] = useState(goals[0]?.id ?? "");
	const [sets, setSets] = useState<SetRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/ext/exercises");
		if (res.ok) setSets(((await res.json()) as { sets: SetRow[] }).sets);
	}, []);
	useEffect(() => void refresh(), [refresh]);

	async function post(url: string, body: unknown): Promise<Record<string, unknown> | null> {
		setError(null);
		const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) {
			setError(typeof json.error === "string" ? json.error : "Request failed.");
			return null;
		}
		return json;
	}
	async function open(body: unknown) {
		const json = await post("/api/ext/office-hours", body);
		if (json && typeof json.chatId === "string") router.push(`/chat/${json.chatId}`);
	}
	async function startReview() {
		const json = await post("/api/ext/review/session", {});
		if (json && typeof json.chatId === "string") router.push(`/chat/${json.chatId}`);
	}
	async function generate() {
		setBusy(true);
		await post("/api/ext/exercises", { goalId });
		setBusy(false);
		void refresh();
	}

	return (
		<div className="flex flex-col gap-8">
			{error !== null ? <p className="text-destructive">{error}</p> : null}
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Daily review</h2>
				<button type="button" className="self-start rounded border px-3 py-1" onClick={() => void startReview()}>Start a review session</button>
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Office hours</h2>
				<p className="text-sm text-muted-foreground">Paste the text your work will be compared with (a solutions manual passage, a textbook proof). Without it you get questions but no verdict.</p>
				<input className="rounded border px-2 py-1" placeholder="Label, e.g. Solutions manual ch. 3" value={label} onChange={(e) => setLabel(e.target.value)} />
				<textarea className="min-h-32 rounded border px-2 py-1" placeholder="Designated source (optional)" value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
				<button type="button" className="self-start rounded border px-3 py-1" disabled={label.trim() === ""} onClick={() => void open({ label, ...(sourceText.trim() ? { sourceText } : {}) })}>Start office hours</button>
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Exercises</h2>
				{goals.length === 0 ? <p className="text-sm text-muted-foreground">Create a goal first.</p> : (
					<div className="flex gap-2">
						<select className="rounded border px-2 py-1" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
							{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
						</select>
						<button type="button" className="rounded border px-3 py-1" disabled={busy || goalId === ""} onClick={() => void generate()}>{busy ? "Generating…" : "Generate a set"}</button>
					</div>
				)}
				{sets.map((s) => (
					<div key={s.setId} className="rounded border p-3">
						<div className="text-xs text-muted-foreground">{goals.find((g) => g.id === s.goalId)?.title ?? s.goalId}{s.applied ? (s.applied.reached ? " · goal reached" : " · results applied") : ""}</div>
						<ul className="flex flex-col gap-2">
							{s.exercises.map((ex) => (
								<li key={ex.id} className="flex items-start gap-2">
									<span className="flex-1">{ex.prompt}{ex.graded ? <em className="ml-2 text-xs">{ex.graded.outcome}{ex.graded.lowConfidence ? " (low confidence)" : ""}</em> : null}</span>
									<button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => void open({ setId: s.setId, exerciseId: ex.id })}>Work on it</button>
								</li>
							))}
						</ul>
					</div>
				))}
			</section>
		</div>
	);
}
