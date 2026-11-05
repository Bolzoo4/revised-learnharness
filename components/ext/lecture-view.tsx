"use client";

import type { Lecture } from "@/src/core";
import { LecturePlayer } from "./lecture-player";
import { openNodePanel } from "./open-node";

/** The lecture beside the node panel: a concept click opens the node in the panel without leaving the lecture (REQ-lec-10). */
export function LectureView({ lecture }: { lecture: Lecture }) {
	return <LecturePlayer lecture={lecture} onNodeClick={openNodePanel} />;
}
