import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExerciseList } from "../components/ext/exercise-list.tsx";
import { LecturesTree } from "../components/ext/lectures-tree.tsx";
import { buildLectureTree } from "../components/ext/lectures-tree.ts";

const PROMPT = "Show that the union of two sigma algebras need not be one.";

const lecture = {
	id: "lec_b1_c01_l01",
	bookId: "b1",
	title: "Sigma algebras",
	bookTitle: "Probability 1",
	chapter: { index: 1, title: "Measurable spaces" },
	order: 1,
	exercises: [{ blockId: "b5", prompt: PROMPT }],
};

describe("ExerciseList", () => {
	it("shows each exercise's prompt, clamped to two lines, with an Open office hours button", () => {
		const html = renderToStaticMarkup(<ExerciseList lectureId="lec_b1_c01_l01" exercises={lecture.exercises} onStarted={() => {}} />);
		assert.ok(html.includes(PROMPT));
		assert.ok(html.includes("line-clamp-2"));
		assert.ok(html.includes("Open office hours"));
		assert.ok(html.includes("Exercise 1"));
		assert.equal(html.includes("disabled"), false);
	});
	it("says in plain words when a lecture has no exercises, with no button", () => {
		const html = renderToStaticMarkup(<ExerciseList lectureId="lec_1" exercises={[]} onStarted={() => {}} />);
		assert.ok(html.includes("No exercises in this lecture."));
		assert.equal(html.includes("Open office hours"), false);
	});
});

describe("LecturesTree", () => {
	it("renders book, chapter, a link to the lecture, and the lecture's exercise with its button", () => {
		const books = buildLectureTree(
			[{ bookId: "b1", title: "Probability 1", phase: "done", chapters: [{ chapter: { index: 1, title: "Measurable spaces" }, state: "done", lectures: 1, uncovered: 0 }] }],
			[lecture],
		);
		const html = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(html.includes("Probability 1"));
		assert.ok(html.includes("Chapter 1: Measurable spaces"));
		assert.ok(html.includes('href="/lectures/lec_b1_c01_l01"'));
		assert.ok(html.includes("1. Sigma algebras"));
		assert.ok(html.includes(PROMPT));
		assert.ok(html.includes("Open office hours"));
		assert.ok(html.includes("done"));
	});
	it("says in plain words when a chapter has no lectures yet", () => {
		const books = buildLectureTree(
			[{ bookId: "b9", title: "New book", phase: "running", chapters: [{ chapter: { index: 1, title: "Start" }, state: "graph", lectures: 0, uncovered: 0 }] }],
			[],
		);
		const html = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(html.includes("reading the chapter"));
		assert.ok(html.includes("No lectures for this chapter yet."));
	});
});
