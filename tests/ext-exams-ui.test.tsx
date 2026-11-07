// tests/ext-exams-ui.test.tsx
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionList, CreateCollectionForm } from "../components/ext/exams-home.tsx";
import { ExamList, MaterialList } from "../components/ext/exams-collection.tsx";
import { ExerciseCards } from "../components/ext/exams-review.tsx";
import { PdfChooser } from "../components/ext/pdf-chooser.tsx";

const EXAM = { id: "exam-1", collectionId: "col-1", title: "Esame 2025", documentId: "d1", pages: 6, reviewed: false };
const REVIEWED = { ...EXAM, id: "exam-2", reviewed: true };
const EXERCISES = [
	{ id: "ex-1", examId: "exam-1", order: 1, pageStart: 1, pageEnd: 2, text: "Compute the limit of sin x over x." },
	{ id: "ex-2", examId: "exam-1", order: 2, pageStart: 3, pageEnd: 3, text: "Prove that the series converges." },
];
const noop = () => {};
const noopOp = async () => true;

function cards(over: Partial<Parameters<typeof ExerciseCards>[0]> = {}) {
	return renderToStaticMarkup(
		<ExerciseCards exercises={EXERCISES} reviewed={false} busy={false} error={null} onOp={noopOp} onPractice={noop} onMarkReviewed={noop} {...over} />,
	);
}

/** The button tags in a markup string, by their visible label. */
function button(html: string, label: string): string {
	const m = html.match(new RegExp(`<button[^>]*>${label}</button>`));
	assert.ok(m, `a button labelled "${label}" is rendered`);
	return m[0];
}

describe("the review list of an exam (REQ-ex-03)", () => {
	it("shows each exercise with its number, page span and text", () => {
		const html = cards();
		assert.match(html, /Exercise 1/);
		assert.match(html, /pp\. 1–2/);
		assert.match(html, /Compute the limit of sin x over x\./);
		assert.match(html, /Exercise 2/);
		assert.match(html, /p\. 3/);
		assert.match(html, /2 exercises/);
	});

	it("offers Merge with next, Split here, Edit, Delete and Mark as reviewed", () => {
		const html = cards();
		for (const label of ["Merge with next", "Split here", "Edit", "Delete", "Practice"]) assert.ok(html.includes(`>${label}</button>`), label);
		assert.match(html, />Mark as reviewed</);
	});

	it("the last exercise cannot be merged with a next one", () => {
		const html = cards();
		const merges = html.match(/<button[^>]*>Merge with next<\/button>/g) ?? [];
		assert.equal(merges.length, 2);
		assert.doesNotMatch(merges[0]!, /disabled=""/, "the first one can merge with the second");
		assert.match(merges[1]!, /disabled=""/, "the last one has nothing to merge with");
	});

	it("the exercise text is read-only until Edit is chosen", () => {
		const html = cards();
		assert.match(html, /<textarea[^>]*readOnly=""/);
	});

	it("says in plain words when an exam has no exercises", () => {
		const html = cards({ exercises: [] });
		assert.match(html, /No exercises were found in this exam\./);
		assert.doesNotMatch(html, />Practice<\/button>/);
	});

	it("shows the server's fixed message when an edit was refused", () => {
		assert.match(cards({ error: "that exercise no longer exists" }), /that exercise no longer exists/);
	});
});

describe("practice waits for the review (REQ-ex-03)", () => {
	it("every Practice button is disabled while the exam is not reviewed, and the list says why", () => {
		const html = cards({ reviewed: false });
		const practices = html.match(/<button[^>]*>Practice<\/button>/g) ?? [];
		assert.equal(practices.length, 2);
		for (const p of practices) assert.match(p, /disabled=""/);
		assert.match(html, /Practice opens when you mark the exam as reviewed/);
		assert.doesNotMatch(button(html, "Mark as reviewed"), /disabled=""/, "the review itself is available");
	});

	it("the Practice buttons are enabled once the exam is reviewed, and the review button goes", () => {
		const html = cards({ reviewed: true });
		const practices = html.match(/<button[^>]*>Practice<\/button>/g) ?? [];
		for (const p of practices) assert.doesNotMatch(p, /disabled=""/);
		assert.doesNotMatch(html, />Mark as reviewed</);
		assert.match(html, />Reviewed</);
	});

	it("the list of exams shows which are reviewed", () => {
		const html = renderToStaticMarkup(<ExamList exams={[EXAM, REVIEWED]} selectedId={null} onReview={noop} />);
		assert.match(html, /not reviewed yet/);
		assert.match(html, /· reviewed/);
	});
});

describe("collections and material", () => {
	it("the collection list links each row to its page", () => {
		const html = renderToStaticMarkup(<CollectionList collections={[{ id: "col 1", title: "Analisi 1", createdAt: "x" }]} />);
		assert.match(html, /href="\/exams\/col%201"/);
		assert.match(html, />Analisi 1</);
	});

	it("an empty collection list says how to start", () => {
		assert.match(renderToStaticMarkup(<CollectionList collections={[]} />), /No collections yet/);
	});

	it("the create form cannot submit an empty title", () => {
		const html = renderToStaticMarkup(<CreateCollectionForm busy={false} onCreate={async () => true} />);
		assert.match(button(html, "Create"), /disabled=""/);
	});

	it("exams and material each have the PDF chooser with the file name title", () => {
		const exams = renderToStaticMarkup(<PdfChooser busy={false} onPick={noop} onError={noop} />);
		assert.match(exams, /Choose a PDF/);
		assert.match(exams, /Title \(optional; the file name is used when empty\)/);
		assert.match(renderToStaticMarkup(<MaterialList materials={[]} />), /No material yet/);
	});

	it("a material row shows its title and page count", () => {
		const html = renderToStaticMarkup(
			<MaterialList materials={[{ id: "m1", collectionId: "c", title: "Dispensa", documentId: "d", pages: 1, indexedAt: "x" }]} />,
		);
		assert.match(html, /Dispensa/);
		assert.match(html, /1 page/);
	});

	it("an exam row offers Review exercises and marks the selected one", () => {
		const html = renderToStaticMarkup(<ExamList exams={[EXAM]} selectedId={EXAM.id} onReview={noop} />);
		assert.match(html, /aria-pressed="true"/);
		assert.match(html, />Review exercises</);
	});
});
