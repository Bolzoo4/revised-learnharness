"use client";

import { useState } from "react";
import { startOfficeHours } from "./office-hours-start.ts";

export interface ExerciseItem {
	blockId: string;
	prompt: string;
}

/**
 * The exercises of one lecture, each with its prompt (two lines at most) and an "Open office hours"
 * button. The button starts a session on the lecture's chapter with this exercise as its focus;
 * onStarted receives the new chat id (the caller navigates to it).
 */
export function ExerciseList({ lectureId, exercises, onStarted }: { lectureId: string; exercises: ExerciseItem[]; onStarted: (chatId: string) => void }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (exercises.length === 0) return <p className="text-sm text-muted-foreground">No exercises in this lecture.</p>;

	async function open(blockId: string) {
		setError(null);
		setBusy(blockId);
		try {
			const result = await startOfficeHours(fetch, lectureId, blockId);
			if ("error" in result) setError(result.error);
			else onStarted(result.chatId);
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<ul className="flex flex-col gap-2">
				{exercises.map((e, i) => (
					<li key={e.blockId} className="flex flex-col items-start gap-1 rounded border p-2">
						<p className="line-clamp-2 text-sm" title={e.prompt}>
							<span className="text-muted-foreground">Exercise {i + 1}: </span>
							{e.prompt}
						</p>
						<button type="button" className="rounded border px-2 py-1 text-sm" disabled={busy !== null} onClick={() => void open(e.blockId)}>
							{busy === e.blockId ? "Opening..." : "Open office hours"}
						</button>
					</li>
				))}
			</ul>
			{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
		</div>
	);
}
