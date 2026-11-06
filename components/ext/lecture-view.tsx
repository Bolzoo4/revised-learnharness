"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ExerciseList, type ExerciseItem } from "./exercise-list.tsx";
import type { Lecture } from "@/src/core";
import { createLectureActivityClient } from "./lecture-activity";
import { LecturePlayer } from "./lecture-player";
import { openNodePanel } from "./open-node";

/**
 * The lecture beside the node panel: a concept click opens the node in the panel without leaving the lecture (REQ-lec-10).
 * Playback is traced for the session debrief (REQ-deb-03). Under the player, the lecture's exercises, each with
 * "Open office hours" (the page computes the exercises from the lecture: exercisesOf).
 */
export function LectureView({ lecture, exercises }: { lecture: Lecture; exercises: ExerciseItem[] }) {
	const router = useRouter();
	const activity = useMemo(() => createLectureActivityClient({ lectureId: lecture.id }), [lecture.id]);
	return (
		<>
			<LecturePlayer
				lecture={lecture}
				onProgress={activity}
				onNodeClick={(nodeId) => {
					activity.concept(nodeId);
					openNodePanel(nodeId);
				}}
			/>
			<section className="mt-6 flex flex-col gap-2">
				<h2 className="font-medium">Exercises in this lecture</h2>
				<ExerciseList lectureId={lecture.id} exercises={exercises} onStarted={(chatId) => router.push(`/chat/${chatId}`)} />
			</section>
		</>
	);
}
