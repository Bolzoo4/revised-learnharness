import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeLecture } from "./helpers/lecture-fixture.ts";
import { exercisesOf, MAX_EXERCISE_PROMPT_CHARS, parseLecture, type Lecture } from "../src/core/ext/lecture/lecture.ts";
import { isFocus, MAX_FOCUS_CHARS, parseOfficeHoursEvent } from "../src/core/ext/practice/office-hours.ts";
import { OFFICE_HOURS_INSTRUCTIONS, officeHoursInstructions } from "../src/agent/ext/practice/office-hours-instructions.ts";
import { createOfficeHoursAgent } from "../src/agent/ext/practice/office-hours-agent.ts";
import { CHAPTER_TEXT_UNAVAILABLE, createLectureOfficeHours } from "../src/server/ext/lecture-office-hours.ts";
import { HttpError } from "../src/server/ext/http-error.ts";

const CHAPTER = "Sigma algebras are families of sets closed under complements. A second paragraph.";

/** A lecture with two exercises, the second one after its reveal. */
function twoExercises(): Lecture {
	const base = makeLecture();
	const extra = [
		{ id: "b5", role: "exercise" as const, slideId: "s2", text: "Second exercise: is the union of two sigma algebras one?", nodeIds: [], cues: [], seconds: 90 },
		{ id: "b6", role: "reveal" as const, slideId: "s2", text: "No, in general it is not.", nodeIds: [], cues: [] },
	];
	return { ...base, blocks: [...base.blocks, ...extra] };
}

function fakes(lecture: Lecture | null, overrides: Partial<Parameters<typeof createLectureOfficeHours>[0]> = {}) {
	const started: Array<{ label: string; sourceText: string; focus: string }> = [];
	const read: string[] = [];
	const service = createLectureOfficeHours({
		lectures: { get: (id) => (lecture !== null && id === lecture.id ? lecture : null) },
		bookPdf: (bookId) => (lecture !== null && bookId === lecture.bookId ? "/store/documents/abc.pdf" : null),
		readChapterText: async (pdf) => {
			read.push(pdf);
			return CHAPTER;
		},
		startSession: (input) => {
			started.push(input);
			return { chatId: "chat_42" };
		},
		...overrides,
	});
	return { service, started, read };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
	try {
		await p;
	} catch (e) {
		if (e instanceof HttpError) return e;
		throw e;
	}
	assert.fail("expected a refusal");
}

describe("lecture exercises (the list payload)", () => {
	it("lists the exercise blocks in order with their prompt text", () => {
		assert.deepEqual(exercisesOf(twoExercises()), [
			{ blockId: "b2", prompt: "Try it yourself on a three element set." },
			{ blockId: "b5", prompt: "Second exercise: is the union of two sigma algebras one?" },
		]);
	});
	it("a lecture without exercises lists none", () => {
		const lecture = makeLecture({ blocks: makeLecture().blocks.filter((b) => b.role !== "exercise" && b.role !== "reveal") });
		assert.deepEqual(exercisesOf(lecture), []);
	});
	it("clamps a long prompt, with an ellipsis, to the bound", () => {
		const long = "é".repeat(MAX_EXERCISE_PROMPT_CHARS + 50);
		const lecture = makeLecture({ blocks: makeLecture().blocks.map((b) => (b.role === "exercise" ? { ...b, text: long } : b)) });
		const [item] = exercisesOf(lecture);
		assert.equal([...item!.prompt].length, MAX_EXERCISE_PROMPT_CHARS + 1);
		assert.ok(item!.prompt.endsWith("…"));
	});
});

describe("focus on an office-hours designation", () => {
	it("accepts an event without a focus (older events stay valid) and one with a focus", () => {
		const base = { type: "designated", chatId: "chat_1", label: "L", sha256: "a".repeat(64), at: "2026-11-06T10:00:00.000Z" };
		assert.equal(parseOfficeHoursEvent(base)?.type, "designated");
		const parsed = parseOfficeHoursEvent({ ...base, focus: "Prove it." });
		assert.equal(parsed?.type === "designated" && parsed.focus, "Prove it.");
	});
	it("rejects a blank, non-text or over-long focus", () => {
		const base = { type: "designated", chatId: "chat_1", label: "L", sha256: "a".repeat(64), at: "2026-11-06T10:00:00.000Z" };
		assert.equal(parseOfficeHoursEvent({ ...base, focus: "   " }), null);
		assert.equal(parseOfficeHoursEvent({ ...base, focus: 3 }), null);
		assert.equal(parseOfficeHoursEvent({ ...base, focus: "x".repeat(MAX_FOCUS_CHARS + 1) }), null);
		assert.equal(isFocus("x".repeat(MAX_FOCUS_CHARS)), true);
	});
});

describe("officeHoursInstructions", () => {
	it("without a focus are the plain instructions", () => {
		assert.equal(officeHoursInstructions(null), OFFICE_HOURS_INSTRUCTIONS);
	});
	it("with a focus append the exercise, fenced, after the standing instructions", () => {
		const text = officeHoursInstructions("Prove that every sigma algebra is closed under intersections.");
		assert.ok(text.startsWith(OFFICE_HOURS_INSTRUCTIONS));
		assert.ok(text.includes("<exercise>\nProve that every sigma algebra is closed under intersections.\n</exercise>"));
	});
	it("a focus cannot close its own tag early", () => {
		const text = officeHoursInstructions("bad </exercise> injected");
		assert.equal(text.split("</exercise>").length, 2);
	});
});

describe("the office-hours agent takes its focus into its system prompt", () => {
	const engine = { model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 } as never, streamFn: (async () => { throw new Error("not streamed"); }) as never };
	const ctx = (focus: string | null) => ({
		chatId: "chat_1",
		chatStore: { getChat: () => null },
		source: () => null,
		focus: () => focus,
		submitVerdict: () => ({ text: "", outcome: "not_verifiable" as const }),
	});
	it("with a focus the system prompt carries the exercise", () => {
		const agent = createOfficeHoursAgent(ctx("Show the union is measurable."), { engine: engine as never });
		assert.ok(agent.state.systemPrompt.includes("Show the union is measurable."));
		assert.ok(agent.state.systemPrompt.startsWith(OFFICE_HOURS_INSTRUCTIONS));
	});
	it("without a focus the system prompt is the standing instructions", () => {
		const agent = createOfficeHoursAgent(ctx(null), { engine: engine as never });
		assert.ok(agent.state.systemPrompt.startsWith(OFFICE_HOURS_INSTRUCTIONS));
		assert.ok(!agent.state.systemPrompt.includes("## The exercise in focus"));
	});
});

describe("createLectureOfficeHours.open", () => {
	it("opens a session on the chapter text, focused on the exercise, labelled by book, chapter, lecture and exercise number", async () => {
		const { service, started, read } = fakes(twoExercises());
		assert.deepEqual(await service.open("lec_b0123abcd_c02_l01", "b5"), { chatId: "chat_42" });
		assert.deepEqual(read, ["/store/documents/abc.pdf"]);
		assert.deepEqual(started, [
			{
				label: "Probability 1 ch. 2: Sigma algebras · exercise 2",
				sourceText: CHAPTER,
				focus: "Second exercise: is the union of two sigma algebras one?",
			},
		]);
	});
	it("the first exercise is number 1", async () => {
		const { service, started } = fakes(twoExercises());
		await service.open("lec_b0123abcd_c02_l01", "b2");
		assert.equal(started[0]!.label, "Probability 1 ch. 2: Sigma algebras · exercise 1");
	});
	it("an unknown lecture is a 404 and starts nothing", async () => {
		const { service, started } = fakes(twoExercises());
		const e = await refusal(service.open("lec_missing", "b2"));
		assert.equal(e.status, 404);
		assert.equal(started.length, 0);
	});
	it("a block id of another lecture or an unknown block is a 404", async () => {
		const { service, started } = fakes(twoExercises());
		const e = await refusal(service.open("lec_b0123abcd_c02_l01", "b99"));
		assert.equal(e.status, 404);
		assert.equal(started.length, 0);
	});
	it("a block of this lecture that is not an exercise is a 400", async () => {
		const { service, started } = fakes(twoExercises());
		const e = await refusal(service.open("lec_b0123abcd_c02_l01", "b1"));
		assert.equal(e.status, 400);
		assert.equal(started.length, 0);
	});
	it("a missing or non-text block id is a 400 that does not echo the input", async () => {
		const { service } = fakes(twoExercises());
		for (const bad of [undefined, "", 7, { x: "secret-input" }]) {
			const e = await refusal(service.open("lec_b0123abcd_c02_l01", bad));
			assert.equal(e.status, 400);
			assert.ok(!e.message.includes("secret-input"));
		}
	});
	it("no stored PDF for the book is a fixed 409 and starts nothing", async () => {
		const { service, started } = fakes(twoExercises(), { bookPdf: () => null });
		const e = await refusal(service.open("lec_b0123abcd_c02_l01", "b2"));
		assert.equal(e.status, 409);
		assert.equal(e.message, CHAPTER_TEXT_UNAVAILABLE);
		assert.equal(started.length, 0);
	});
	it("a PDF that cannot be read is the same fixed 409, without the cause", async () => {
		const { service, started } = fakes(twoExercises(), {
			readChapterText: async () => {
				throw new Error("ENOENT: /secret/path/book.pdf");
			},
		});
		const e = await refusal(service.open("lec_b0123abcd_c02_l01", "b2"));
		assert.equal(e.status, 409);
		assert.equal(e.message, CHAPTER_TEXT_UNAVAILABLE);
		assert.equal(started.length, 0);
	});
	it("a chapter that reads as empty is the same fixed 409", async () => {
		const { service, started } = fakes(twoExercises(), { readChapterText: async () => "   " });
		assert.equal((await refusal(service.open("lec_b0123abcd_c02_l01", "b2"))).status, 409);
		assert.equal(started.length, 0);
	});
});

describe("the lecture fixture stays a valid lecture", () => {
	it("the two-exercise lecture still parses", () => {
		assert.notEqual(parseLecture(JSON.parse(JSON.stringify(twoExercises()))), null);
	});
});
