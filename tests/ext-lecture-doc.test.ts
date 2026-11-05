import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isValidLectureId,
	lectureId,
	lectureNodeRefs,
	parseLecture,
	parseNodeLinks,
	stripNodeLinks,
	textNodeRefs,
} from "../src/core/ext/lecture/lecture.ts";
import { makeLecture, NODE_A, NODE_B } from "./helpers/lecture-fixture.ts";

describe("lecture ids", () => {
	it("formats and validates", () => {
		assert.equal(lectureId("b0123abcd", 2, 1), "lec_b0123abcd_c02_l01");
		assert.equal(isValidLectureId("lec_b0123abcd_c02_l01"), true);
	});
	it("rejects path-like and malformed ids", () => {
		for (const bad of ["../x", "lec_b0123abcd_c02_l01/../../x", "lec_B0123ABCD_c02_l01", "", "lec_b0123abcd_c2_l1", 7, null]) {
			assert.equal(isValidLectureId(bad), false, String(bad));
		}
	});
});

describe("parseLecture", () => {
	it("round-trips a valid lecture through JSON", () => {
		const l = makeLecture();
		assert.deepEqual(parseLecture(JSON.parse(JSON.stringify(l))), l);
	});
	it("rejects a wrong version, a bad id, an exercise without seconds, a negative cue", () => {
		assert.equal(parseLecture({ ...makeLecture(), version: 2 }), null);
		assert.equal(parseLecture({ ...makeLecture(), id: "x" }), null);
		const noSeconds = makeLecture();
		delete noSeconds.blocks[1]!.seconds;
		assert.equal(parseLecture(noSeconds), null);
		const neg = makeLecture();
		neg.blocks[0]!.cues[0]!.atChar = -1;
		assert.equal(parseLecture(neg), null);
	});
	it("rejects non-objects", () => {
		for (const v of [null, 3, "x", [], undefined]) assert.equal(parseLecture(v), null);
	});
});

describe("node links", () => {
	it("splits text and links in order and never loses text", () => {
		const text = "see [[n_aaaa1111|sigma]] and [[n_bbbb2222]] now";
		const parts = parseNodeLinks(text);
		assert.deepEqual(parts, [
			{ kind: "text", text: "see " },
			{ kind: "node", nodeId: NODE_A, label: "sigma" },
			{ kind: "text", text: " and " },
			{ kind: "node", nodeId: NODE_B, label: null },
			{ kind: "text", text: " now" },
		]);
		assert.equal(stripNodeLinks(text), "see sigma and n_bbbb2222 now");
	});
	it("ignores malformed links", () => {
		assert.deepEqual(parseNodeLinks("[[notanode]] [[n_ x]]"), [{ kind: "text", text: "[[notanode]] [[n_ x]]" }]);
	});
	it("lists refs once each", () => {
		assert.deepEqual(textNodeRefs("[[n_aaaa1111]] [[n_aaaa1111|again]]"), [NODE_A]);
	});
});

describe("lectureNodeRefs", () => {
	it("unions block citations and slide links, first appearance order", () => {
		assert.deepEqual(lectureNodeRefs(makeLecture()), [NODE_A, NODE_B]);
	});
});
