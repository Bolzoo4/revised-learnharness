import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedbackFromErrors, firstSharedRun, uncoveredChapterNodes, validateLecture } from "../src/core/ext/lecture/validate.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

const CTX = { existingNodeIds: new Set([NODE_A, NODE_B]), chapterText: "Completely unrelated source material about something else entirely." };

describe("validateLecture", () => {
	it("accepts the fixture lecture", () => {
		assert.deepEqual(validateLecture(makeLecture(), CTX), []);
	});
	it("rejects a block that cites a non-existent node", () => {
		const l = makeLecture();
		l.blocks[0]!.nodeIds = ["n_ghost000"];
		assert.match(validateLecture(l, CTX).join("\n"), /unknown node n_ghost000/);
	});
	it("rejects a slide link to a non-existent node", () => {
		const l = makeLecture();
		l.slides[0]!.elements[0]!.content = "see [[n_ghost000]]";
		assert.match(validateLecture(l, CTX).join("\n"), /slide links unknown node n_ghost000/);
	});
	it("rejects a narrate block with no citation but allows a note without one", () => {
		const l = makeLecture();
		l.blocks[0]!.nodeIds = [];
		const errors = validateLecture(l, CTX);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /narrate block b1 cites no node/);
	});
	it("rejects an exercise without a reveal and a reveal without an exercise", () => {
		const l = makeLecture();
		l.blocks[2]!.role = "note";
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /exercise block b2 must be followed by a reveal/);
		const l2 = makeLecture();
		l2.blocks[1]!.role = "narrate";
		l2.blocks[1]!.nodeIds = [NODE_A];
		assert.match(validateLecture(l2, CTX).join("\n"), /reveal block b3 must follow an exercise/);
	});
	it("rejects cues on unknown elements or past the text", () => {
		const l = makeLecture();
		l.blocks[0]!.cues = [{ atChar: 1, target: "nope", style: "box" }, { atChar: 9999, target: "e1", style: "box" }];
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /unknown element nope/);
		assert.match(text, /past the end/);
	});
	it("rejects unknown slide ids and duplicate ids", () => {
		const l = makeLecture();
		l.blocks[3]!.slideId = "zzz";
		l.blocks[3]!.id = "b1";
		const text = validateLecture(l, CTX).join("\n");
		assert.match(text, /unknown slide zzz/);
		assert.match(text, /duplicate block id b1/);
	});
	it("rejects empty lectures", () => {
		const text = validateLecture(makeLecture({ slides: [], blocks: [] }), CTX).join("\n");
		assert.match(text, /no slides/);
		assert.match(text, /no blocks/);
	});
});

describe("verbatim rule (REQ-lec-08)", () => {
	const source = "A sigma algebra is a family of subsets closed under complements and countable unions of its members.";
	it("flags a 12-word copy even with different case and punctuation", () => {
		const l = makeLecture();
		l.blocks[0]!.text = "Remember: a SIGMA algebra, is a family of subsets closed under complements, and countable unions of its members!";
		const errors = validateLecture(l, { ...CTX, chapterText: source });
		assert.match(errors.join("\n"), /copies the source verbatim/);
	});
	it("does not flag a short shared phrase", () => {
		const l = makeLecture();
		l.blocks[0]!.text = "A sigma algebra is a family of subsets, nothing more.";
		assert.deepEqual(validateLecture(l, { ...CTX, chapterText: source }), []);
	});
	it("the boundary is exactly 12 shared words", () => {
		const src = "one two three four five six seven eight nine ten eleven twelve thirteen";
		assert.notEqual(firstSharedRun("one two three four five six seven eight nine ten eleven twelve", src), null);
		assert.equal(firstSharedRun("one two three four five six seven eight nine ten eleven", src), null);
	});
	it("firstSharedRun edge cases (exact run, no match, too short)", () => {
		assert.equal(firstSharedRun("a b c", "a b c", 3), "a b c");
		assert.equal(firstSharedRun("x", "a b c", 3), null);
		assert.equal(firstSharedRun("a b", "a b c d", 3), null);
	});
});

describe("coverage and feedback", () => {
	it("reports chapter nodes cited by no lecture", () => {
		assert.deepEqual(uncoveredChapterNodes([makeLecture()], [NODE_A, NODE_B, "n_orphan00"]), ["n_orphan00"]);
		assert.deepEqual(uncoveredChapterNodes([], [NODE_A]), [NODE_A]);
	});
	it("formats feedback with one line per error", () => {
		const fb = feedbackFromErrors(["a", "b"]);
		assert.match(fb, /- a\n- b$/);
	});
});
