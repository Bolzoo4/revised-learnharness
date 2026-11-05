import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLecture } from "../src/core/ext/lecture/build.ts";
import { parseLecture } from "../src/core/ext/lecture/lecture.ts";
import { makeLecture } from "./helpers/lecture-fixture.ts";

describe("buildLecture", () => {
	const base = makeLecture();
	const draft = { title: base.title, summary: base.summary, slides: base.slides, blocks: base.blocks };
	const meta = {
		bookId: "b0123abcd",
		bookTitle: "Probability 1",
		chapter: { index: 2, title: "Measurable spaces", pageStart: 10, pageEnd: 30 },
		order: 1,
		chapterSourceId: "src_0123456789ab",
		createdAt: "2026-11-04T10:00:00.000Z",
	};
	it("attaches identity and produces a parseable lecture", () => {
		const l = buildLecture(draft, meta);
		assert.equal(l.id, "lec_b0123abcd_c02_l01");
		assert.deepEqual(parseLecture(JSON.parse(JSON.stringify(l))), base);
	});
	it("drops stray `seconds` from non-exercise blocks", () => {
		const d = { ...draft, blocks: draft.blocks.map((b) => (b.role === "narrate" ? { ...b, seconds: 30 } : b)) };
		const l = buildLecture(d, meta);
		assert.equal("seconds" in l.blocks[0]!, false);
		assert.equal(l.blocks[1]!.seconds, 60);
	});
});
