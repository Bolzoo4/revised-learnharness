// src/core/ext/lecture/lecture-graph.ts
/**
 * Lectures as special graph nodes (REQ-lec-11) and back-links (REQ-lec-12):
 * everything derived from lecture.json, nothing stored, nothing written to
 * the content ledgers.
 */

import { lectureNodeRefs, type Lecture } from "./lecture.ts";

export interface LectureGraphNode {
	id: string;
	title: string;
	kind: "lecture";
}
export interface LectureGraphEdge {
	from: string;
	to: string;
	type: "cites";
}
export interface LectureOverlay {
	nodes: LectureGraphNode[];
	edges: LectureGraphEdge[];
}

/** One special node per lecture, one `cites` edge per cited node that exists. */
export function lectureOverlay(lectures: readonly Lecture[], existingNodeIds: ReadonlySet<string>): LectureOverlay {
	const nodes: LectureGraphNode[] = [];
	const edges: LectureGraphEdge[] = [];
	for (const l of lectures) {
		nodes.push({ id: l.id, title: l.title, kind: "lecture" });
		for (const id of lectureNodeRefs(l)) if (existingNodeIds.has(id)) edges.push({ from: l.id, to: id, type: "cites" });
	}
	return { nodes, edges };
}

export interface CitingLecture {
	id: string;
	title: string;
	bookTitle: string;
	chapterTitle: string;
}

/** Back-links: the lectures that cite `nodeId`, in book/chapter/lecture order. */
export function citingLectures(nodeId: string, lectures: readonly Lecture[]): CitingLecture[] {
	return lectures
		.filter((l) => lectureNodeRefs(l).includes(nodeId))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((l) => ({ id: l.id, title: l.title, bookTitle: l.bookTitle, chapterTitle: l.chapter.title }));
}
