"use client";

import { useMemo } from "react";
import type { Lecture } from "@/src/core";
import { createLectureActivityClient } from "./lecture-activity";
import { LecturePlayer } from "./lecture-player";
import { openNodePanel } from "./open-node";

/** The lecture beside the node panel: a concept click opens the node in the panel without leaving the lecture (REQ-lec-10). Playback is traced for the session debrief (REQ-deb-03). */
export function LectureView({ lecture }: { lecture: Lecture }) {
	const activity = useMemo(() => createLectureActivityClient({ lectureId: lecture.id }), [lecture.id]);
	return (
		<LecturePlayer
			lecture={lecture}
			onProgress={activity}
			onNodeClick={(nodeId) => {
				activity.concept(nodeId);
				openNodePanel(nodeId);
			}}
		/>
	);
}
