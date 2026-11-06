import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookPhaseText, buildLectureTree, chapterStateText, type LectureRow, type RunRow } from "../components/ext/lectures-tree.ts";
import { START_FAILED, startOfficeHours } from "../components/ext/office-hours-start.ts";

const lecture = (over: Partial<LectureRow>): LectureRow => ({
	id: "lec_b1_c01_l01",
	bookId: "b1",
	title: "Lecture",
	bookTitle: "Book",
	chapter: { index: 1, title: "First" },
	order: 1,
	exercises: [],
	...over,
});

describe("buildLectureTree", () => {
	it("groups lectures under their book and chapter, in chapter index and lecture order", () => {
		const tree = buildLectureTree([], [
			lecture({ id: "lec_b1_c02_l01", chapter: { index: 2, title: "Second" }, order: 1, title: "B1" }),
			lecture({ id: "lec_b1_c01_l02", order: 2, title: "A2" }),
			lecture({ id: "lec_b1_c01_l01", order: 1, title: "A1" }),
		]);
		assert.equal(tree.length, 1);
		assert.equal(tree[0]!.title, "Book");
		assert.equal(tree[0]!.phaseText, "saved");
		assert.deepEqual(tree[0]!.chapters.map((c) => c.index), [1, 2]);
		assert.deepEqual(tree[0]!.chapters[0]!.lectures.map((l) => l.title), ["A1", "A2"]);
		assert.equal(tree[0]!.chapters[0]!.stateText, "saved");
	});
	it("takes chapter state, node counts and errors from the run, and the book phase in plain words", () => {
		const runs: RunRow[] = [
			{
				bookId: "b1",
				title: "Probability",
				phase: "running",
				error: "some chapters did not finish",
				chapters: [
					{ chapter: { index: 1, title: "First" }, state: "writing", lectures: 1, uncovered: 3 },
					{ chapter: { index: 2, title: "Second" }, state: "stopped_cost", lectures: 0, uncovered: 0, error: "limit" },
				],
			},
		];
		const [book] = buildLectureTree(runs, [lecture({})]);
		assert.equal(book!.title, "Probability");
		assert.equal(book!.phaseText, "making the lectures");
		assert.equal(book!.error, "some chapters did not finish");
		assert.equal(book!.chapters[0]!.stateText, "writing the lectures");
		assert.equal(book!.chapters[0]!.uncovered, 3);
		assert.equal(book!.chapters[1]!.stateText, "stopped: the daily limit for background work is spent");
		assert.equal(book!.chapters[1]!.error, "limit");
	});
	it("a book with runs but no lectures still shows its chapters", () => {
		const [book] = buildLectureTree([{ bookId: "b9", title: "New", phase: "detecting", chapters: [{ chapter: { index: 1, title: "One" }, state: "queued", lectures: 0, uncovered: 0 }] }], []);
		assert.equal(book!.phaseText, "finding the chapters");
		assert.equal(book!.chapters[0]!.lectures.length, 0);
		assert.equal(book!.chapters[0]!.stateText, "waiting to start");
	});
	it("two books stay apart, keeping the order they were first seen", () => {
		const tree = buildLectureTree([], [lecture({ bookId: "b2", bookTitle: "Second book" }), lecture({ bookId: "b1", bookTitle: "First book" })]);
		assert.deepEqual(tree.map((b) => b.title), ["Second book", "First book"]);
	});
	it("carries the exercises of each lecture", () => {
		const [book] = buildLectureTree([], [lecture({ exercises: [{ blockId: "b2", prompt: "Try it." }] })]);
		assert.deepEqual(book!.chapters[0]!.lectures[0]!.exercises, [{ blockId: "b2", prompt: "Try it." }]);
	});
	it("an unknown state or phase reads as itself", () => {
		assert.equal(chapterStateText("future_state"), "future_state");
		assert.equal(bookPhaseText("future_phase"), "future_phase");
	});
});

describe("startOfficeHours", () => {
	const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

	it("POSTs the block to the lecture's office-hours route and returns the chat id", async () => {
		let seen: { url: string; init?: RequestInit } = { url: "" };
		const f = (async (url: string, init?: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ chatId: "chat_7" }), { status: 201 });
		}) as unknown as typeof fetch;
		assert.deepEqual(await startOfficeHours(f, "lec_1", "b2"), { chatId: "chat_7" });
		assert.equal(seen.url, "/api/ext/lectures/lec_1/office-hours");
		assert.equal(seen.init?.method, "POST");
		assert.deepEqual(JSON.parse(String(seen.init?.body)), { blockId: "b2" });
	});
	it("a server refusal is shown with its own fixed message", async () => {
		assert.deepEqual(await startOfficeHours(fakeFetch(409, { error: "the chapter text is not available: its book PDF is no longer stored" }), "lec_1", "b2"), {
			error: "the chapter text is not available: its book PDF is no longer stored",
		});
	});
	it("an unreadable refusal or a network failure gets the generic message", async () => {
		assert.deepEqual(await startOfficeHours(fakeFetch(500, { error: 7 }), "lec_1", "b2"), { error: START_FAILED });
		const broken = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		assert.deepEqual(await startOfficeHours(broken, "lec_1", "b2"), { error: START_FAILED });
	});
	it("a success without a chat id is the generic message", async () => {
		assert.deepEqual(await startOfficeHours(fakeFetch(201, {}), "lec_1", "b2"), { error: START_FAILED });
	});
});
