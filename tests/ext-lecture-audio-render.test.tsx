import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LecturePlayer } from "../components/ext/lecture-player.tsx";
import { LecturesTree } from "../components/ext/lectures-tree.tsx";
import { buildLectureTree } from "../components/ext/lectures-tree.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

const lecture = { id: "lec_b0123abcd_c02_l01", bookId: "b0123abcd", title: "Sigma algebras", bookTitle: "Probability 1", chapter: { index: 2, title: "Measurable spaces" }, order: 1, exercises: [] };

describe("the lectures tree renders the audio line", () => {
	it("shows the count and the Generate audio button when a key exists and blocks are missing", () => {
		const books = buildLectureTree([], [{ ...lecture, audio: { ready: 2, total: 5, keyConfigured: true } }]);
		const html = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(html.includes("Audio: 2 of 5 blocks ready"));
		assert.ok(html.includes("Generate audio"));
	});
	it("shows the reason and no button without a key", () => {
		const books = buildLectureTree([], [{ ...lecture, audio: { ready: 0, total: 5, keyConfigured: false } }]);
		const html = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(html.includes("no Deepgram key"));
		assert.equal(html.includes("Generate audio"), false);
	});
	it("shows no button when every block is ready", () => {
		const books = buildLectureTree([], [{ ...lecture, audio: { ready: 5, total: 5, keyConfigured: true } }]);
		const html = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(html.includes("Audio: 5 of 5 blocks ready"));
		assert.equal(html.includes("Generate audio"), false);
	});
});

describe("the lecture player", () => {
	it("renders the first block in text mode and the block counter, without any browser speech or fetch at render time", () => {
		const html = renderToStaticMarkup(<LecturePlayer lecture={makeLecture()} />);
		assert.ok(html.includes("Block 1 of 4"));
		assert.ok(html.includes("Play"));
		assert.ok(html.includes("A sigma algebra is a family closed under complements"));
	});
});
