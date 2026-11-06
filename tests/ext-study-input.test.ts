// tests/ext-study-input.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecision, requireString } from "../src/server/ext/study-input.ts";
import { StudyError } from "../src/server/ext/study-service.ts";

const bad = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof StudyError && e.status === 400 && re.test(e.message));

describe("study request parsing", () => {
	it("requireString returns a non-empty string and refuses anything else", () => {
		assert.equal(requireString({ documentId: "abc" }, "documentId"), "abc");
		bad(() => requireString({ documentId: "" }, "documentId"), /documentId is required/);
		bad(() => requireString({ documentId: 7 }, "documentId"), /documentId is required/);
		bad(() => requireString({}, "documentId"), /documentId is required/);
	});
	it("parseDecision keeps edits and defaults to empty lists", () => {
		assert.deepEqual(parseDecision({}), { approve: [], reject: [] });
		assert.deepEqual(parseDecision({ approve: [{ draftId: "d1", question: "Q?", extra: 1 }], reject: ["d2"] }), {
			approve: [{ draftId: "d1", proposition: undefined, question: "Q?", answer: undefined, pin: undefined }],
			reject: ["d2"],
		});
	});
	it("parseDecision refuses non-lists, items without a draftId, non-string rejections and huge requests", () => {
		bad(() => parseDecision({ approve: "d1" }), /must be lists/);
		bad(() => parseDecision({ approve: [{}] }), /needs a draftId/);
		bad(() => parseDecision({ approve: [null] }), /needs a draftId/);
		bad(() => parseDecision({ reject: [3] }), /listed by draftId/);
		bad(() => parseDecision({ reject: Array.from({ length: 201 }, (_, i) => `d${i}`) }), /too many/);
	});
});
