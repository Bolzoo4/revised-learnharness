import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LecturesTree } from "../components/ext/lectures-tree.tsx";
import { buildLectureTree, leftoverConfirmText, leftoversText, type LeftoverRow, type RunRow } from "../components/ext/lectures-tree.ts";
import { LEFTOVERS_REJECTED, removeLeftovers } from "../components/ext/lecture-leftovers-client.ts";

const run = (phase: string, chapters: RunRow["chapters"]): RunRow => ({ bookId: "b0123abcd", title: "Probability 1", phase, chapters });
const ch = (index: number, state: string) => ({ chapter: { index, title: `Chapter ${index}` }, state, lectures: 0, uncovered: 0 });
const leftover = (over: Partial<LeftoverRow> = {}): LeftoverRow => ({ bookId: "b0123abcd", chapterIndex: 2, nodes: 3, chains: 1, kept: 2, ...over });

describe("leftover wording", () => {
	it("says how many nodes an earlier attempt left in the graph, in plain words", () => {
		assert.equal(leftoversText({ nodes: 3, chains: 1, kept: 0 }), "3 nodes from an earlier attempt are still in your graph");
		assert.equal(leftoversText({ nodes: 1, chains: 0, kept: 0 }), "1 node from an earlier attempt is still in your graph");
		assert.equal(leftoversText({ nodes: 0, chains: 2, kept: 0 }), "2 links from an earlier attempt are still in your graph");
		assert.equal(leftoversText({ nodes: 0, chains: 0, kept: 0 }), "An earlier attempt left its source in your library");
	});
	it("the confirm step shows the numbers first, and says that shared nodes stay", () => {
		assert.equal(leftoverConfirmText({ nodes: 3, chains: 1, kept: 2 }), "Remove 3 nodes and 1 link from your graph? 2 nodes that other chapters, lectures or chats also use stay.");
		assert.equal(leftoverConfirmText({ nodes: 1, chains: 0, kept: 0 }), "Remove 1 node and 0 links from your graph?");
	});
});

describe("buildLectureTree with leftovers", () => {
	it("attaches the leftovers to the chapter that has no lecture, and to no other", () => {
		const runs = [run("failed", [ch(1, "done"), ch(2, "failed"), ch(3, "failed")])];
		const [book] = buildLectureTree(runs, [], [leftover({ chapterIndex: 2 }), leftover({ chapterIndex: 9 })]);
		assert.deepEqual(book!.chapters[1]!.leftovers, { nodes: 3, chains: 1, kept: 2 });
		assert.equal(book!.chapters[0]!.leftovers, undefined);
		assert.equal(book!.chapters[2]!.leftovers, undefined, "a row for a chapter the run does not know is ignored");
	});
	it("keeps the tree as it was when there are no leftovers", () => {
		const [book] = buildLectureTree([run("failed", [ch(2, "failed")])], []);
		assert.equal(book!.chapters[0]!.leftovers, undefined);
	});
});

describe("LecturesTree leftover control", () => {
	it("a chapter with leftovers shows the note and a Remove them button, and no confirm step before the click", () => {
		const books = buildLectureTree([run("failed", [ch(2, "failed")])], [], [leftover()]);
		const out = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.ok(out.includes("3 nodes from an earlier attempt are still in your graph"));
		assert.ok(out.includes("Remove them"));
		assert.equal(out.includes("also use stay"), false, "the confirm step is not shown until the button is pressed");
	});
	it("a finished book or a chapter without leftovers shows no leftover control", () => {
		const books = buildLectureTree([run("done", [ch(1, "done")])], []);
		const out = renderToStaticMarkup(<LecturesTree books={books} onStarted={() => {}} />);
		assert.equal(out.includes("Remove them"), false);
		assert.equal(out.includes("from an earlier attempt"), false);
	});
});

describe("removeLeftovers", () => {
	afterEach(() => mock.restoreAll());

	it("posts the chapter index to the purge route and returns null when it is removed", async () => {
		const calls: Array<{ url: string; body: string }> = [];
		mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, body: String(init.body) });
			return new Response(JSON.stringify({ nodesRemoved: 3, chainsRemoved: 1, nodesKept: 2 }), { status: 200 });
		});
		assert.equal(await removeLeftovers("b0123abcd", 2), null);
		assert.deepEqual(calls, [{ url: "/api/ext/lectures/b0123abcd/purge", body: '{"chapterIndex":2}' }]);
	});
	it("returns the server's fixed refusal text", async () => {
		mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "the book is still being made; retry when it finishes" }), { status: 409 }));
		assert.equal(await removeLeftovers("b0123abcd", 2), "the book is still being made; retry when it finishes");
	});
	it("returns the generic text when the request fails", async () => {
		mock.method(globalThis, "fetch", async () => {
			throw new Error("offline");
		});
		assert.equal(await removeLeftovers("b0123abcd", 2), LEFTOVERS_REJECTED);
	});
});
