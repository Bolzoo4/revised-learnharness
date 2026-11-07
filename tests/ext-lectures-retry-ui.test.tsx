import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LecturesTree } from "../components/ext/lectures-tree.tsx";
import { buildLectureTree, chapterStateText, isRetryableChapterState, type RunRow } from "../components/ext/lectures-tree.ts";
import { RETRY_REJECTED, startLectureRetry } from "../components/ext/lecture-retry-client.ts";

const run = (phase: string, chapters: RunRow["chapters"], error?: string): RunRow => ({ bookId: "b0123abcd", title: "Probability 1", phase, chapters, ...(error ? { error } : {}) });
const ch = (index: number, state: string, error?: string) => ({ chapter: { index, title: `Chapter ${index}` }, state, lectures: 0, uncovered: 0, ...(error ? { error } : {}) });
const EXPLAINED = "the extractor never submitted findings (x6). The model stopped before calling the tool. This usually means it ran out of output space: lower the thinking level or choose a model with a larger output limit in Settings.";

function html(runs: RunRow[]) {
	return renderToStaticMarkup(<LecturesTree books={buildLectureTree(runs, [])} onStarted={() => {}} />);
}

describe("interrupted and retry wording", () => {
	it("shows the interrupted state in plain words and marks which states can be retried", () => {
		assert.equal(chapterStateText("interrupted"), "interrupted");
		for (const s of ["failed", "interrupted", "stopped_cost", "stopped_provider"]) assert.equal(isRetryableChapterState(s), true, s);
		for (const s of ["done", "queued", "graph", "outline", "writing", "saved"]) assert.equal(isRetryableChapterState(s), false, s);
	});
});

describe("LecturesTree retry controls", () => {
	it("a failed chapter shows its explained error wrapped, a Retry button, and a book-level Retry failed chapters button", () => {
		const out = html([run("failed", [ch(1, "done"), ch(2, "failed", EXPLAINED)])]);
		assert.ok(out.includes("Retry failed chapters"));
		assert.equal(out.split(">Retry<").length - 1, 1, "one chapter Retry button, for the failed chapter only");
		assert.ok(out.includes("whitespace-pre-wrap break-words"));
		assert.ok(out.includes("The model stopped before calling the tool."));
		assert.equal(out.split("never submitted").length - 1, 1, "the repeated text is shown once");
	});
	it("an interrupted chapter reads interrupted and can be retried; a finished book offers no retry", () => {
		const interrupted = html([run("interrupted", [ch(1, "done"), ch(2, "interrupted", "interrupted when the app was closed"), ch(3, "queued")], "interrupted when the app was closed")]);
		assert.ok(interrupted.includes("interrupted"));
		assert.ok(interrupted.includes(">Retry<"));
		assert.ok(interrupted.includes("Retry failed chapters"));
		const done = html([run("done", [ch(1, "done")])]);
		assert.equal(done.includes("Retry"), false);
	});
	it("a book still being made disables its retry buttons", () => {
		const out = html([run("running", [ch(1, "failed", "x"), ch(2, "writing")])]);
		const buttons = out.split("<button").slice(1);
		assert.ok(buttons.length >= 2);
		assert.ok(buttons.every((b) => b.includes("disabled")), "every retry button is disabled while the book runs");
	});
});

describe("startLectureRetry", () => {
	afterEach(() => mock.restoreAll());

	it("posts the chapter index (or nothing) and returns null when the retry started", async () => {
		const bodies: string[] = [];
		const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return new Response(JSON.stringify({ bookId: "b0123abcd", chapters: [2] }), { status: 202 });
		});
		assert.equal(await startLectureRetry("b0123abcd", 2), null);
		assert.equal(await startLectureRetry("b0123abcd"), null);
		assert.deepEqual(bodies, ['{"chapterIndex":2}', "{}"]);
		assert.equal(fetchMock.mock.calls[0]!.arguments[0], "/api/ext/lectures/b0123abcd/retry");
	});
	it("returns the server's fixed refusal text", async () => {
		mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "that chapter is already running" }), { status: 409 }));
		assert.equal(await startLectureRetry("b0123abcd", 2), "that chapter is already running");
	});
	it("returns the generic text when the request fails", async () => {
		mock.method(globalThis, "fetch", async () => {
			throw new Error("offline");
		});
		assert.equal(await startLectureRetry("b0123abcd"), RETRY_REJECTED);
	});
});
