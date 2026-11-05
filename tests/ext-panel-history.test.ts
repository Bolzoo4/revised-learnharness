// tests/ext-panel-history.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EMPTY_HISTORY,
	historyBack,
	historyCanBack,
	historyCanForward,
	historyCurrent,
	historyForward,
	historyOpen,
} from "../src/core/ext/panel-history.ts";

describe("panel history (REQ-node-13)", () => {
	it("starts empty", () => {
		assert.equal(historyCurrent(EMPTY_HISTORY), null);
		assert.equal(historyCanBack(EMPTY_HISTORY), false);
		assert.equal(historyCanForward(EMPTY_HISTORY), false);
	});

	it("opening nodes builds a trail that back and forward walk", () => {
		let h = historyOpen(historyOpen(historyOpen(EMPTY_HISTORY, "a"), "b"), "c");
		assert.equal(historyCurrent(h), "c");
		h = historyBack(historyBack(h));
		assert.equal(historyCurrent(h), "a");
		assert.equal(historyCanBack(h), false);
		assert.equal(historyCanForward(h), true);
		h = historyForward(h);
		assert.equal(historyCurrent(h), "b");
	});

	it("opening after going back drops the forward entries", () => {
		let h = historyOpen(historyOpen(historyOpen(EMPTY_HISTORY, "a"), "b"), "c");
		h = historyOpen(historyBack(historyBack(h)), "z");
		assert.deepEqual(h.entries, ["a", "z"]);
		assert.equal(historyCanForward(h), false);
	});

	it("re-opening the current node changes nothing; back at the start is a no-op", () => {
		const h = historyOpen(EMPTY_HISTORY, "a");
		assert.equal(historyOpen(h, "a"), h);
		assert.equal(historyBack(h), h);
		assert.equal(historyForward(h), h);
	});
});
