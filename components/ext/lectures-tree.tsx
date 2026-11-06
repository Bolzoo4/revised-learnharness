"use client";

import { useState } from "react";
import { ExerciseList } from "./exercise-list.tsx";
import { startLectureAudio } from "./lecture-audio-client.ts";
import { audioLineText, canGenerateAudioLine, type TreeBook, type TreeLecture } from "./lectures-tree.ts";

/** Book > chapter > lecture > exercise. Each exercise can open office hours on its chapter (ExerciseList). */
export function LecturesTree({ books, onStarted }: { books: TreeBook[]; onStarted: (chatId: string) => void }) {
	return (
		<div className="flex flex-col gap-4">
			{books.map((book) => (
				<section key={book.bookId} className="rounded border p-3">
					<h2 className="font-medium">
						{book.title} <span className="text-xs text-muted-foreground">{book.phaseText}</span>
					</h2>
					{book.error ? <p className="text-sm text-destructive">{book.error}</p> : null}
					<ol className="mt-2 flex flex-col gap-3">
						{book.chapters.map((chapter) => (
							<li key={chapter.index} className="flex flex-col gap-2">
								<h3 className="text-sm font-medium">
									Chapter {chapter.index}: {chapter.title}{" "}
									<span className="text-xs text-muted-foreground">
										{chapter.stateText}
										{chapter.lectures.length > 0 ? `, ${chapter.lectures.length} lecture${chapter.lectures.length === 1 ? "" : "s"}` : ""}
										{chapter.uncovered > 0 ? `, ${chapter.uncovered} nodes not covered yet` : ""}
									</span>
								</h3>
								{chapter.error ? <p className="text-sm text-destructive">{chapter.error}</p> : null}
								{chapter.lectures.length === 0 ? <p className="text-sm text-muted-foreground">No lectures for this chapter yet.</p> : null}
								<ul className="flex flex-col gap-3 pl-3">
									{chapter.lectures.map((lecture) => (
										<li key={lecture.id} className="flex flex-col gap-2">
											<a className="text-sm underline" href={`/lectures/${lecture.id}`}>
												{lecture.order}. {lecture.title}
											</a>
											<LectureAudioLine lecture={lecture} />
											<ExerciseList lectureId={lecture.id} exercises={lecture.exercises} onStarted={onStarted} />
										</li>
									))}
								</ul>
							</li>
						))}
					</ol>
				</section>
			))}
		</div>
	);
}

/** The lecture's narration audio: the count of ready blocks, and "Generate audio" for the missing ones (background; the page's refresh shows the count). */
function LectureAudioLine({ lecture }: { lecture: TreeLecture }) {
	const [pending, setPending] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	if (lecture.audio === undefined) return null;
	const audio = lecture.audio;
	async function generate() {
		setPending(true);
		const failure = await startLectureAudio(lecture.id);
		setPending(false);
		setNote(failure ?? "Generating in the background; the count updates as the blocks finish.");
	}
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span>{audioLineText(audio)}</span>
			{canGenerateAudioLine(audio) ? (
				<button type="button" className="rounded border px-2 py-0.5" disabled={pending} onClick={() => void generate()}>
					{pending ? "Starting…" : "Generate audio"}
				</button>
			) : null}
			{note !== null ? <span role="status">{note}</span> : null}
		</div>
	);
}
