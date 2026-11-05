import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import * as core from "../src/core/index.ts";

describe("browser-safe core barrel for the lecture player", () => {
	it("exports what the player needs", () => {
		assert.equal(typeof core.activeCue, "function");
		assert.equal(typeof core.parseNodeLinks, "function");
		assert.equal(typeof core.stripNodeLinks, "function");
		assert.deepEqual(core.parseNodeLinks("a [[n_x|b]] c").map((p) => p.kind), ["text", "node", "text"]);
	});
	it("the modules behind it import nothing from node:", () => {
		for (const f of ["src/core/ext/lecture/lecture.ts", "src/core/ext/lecture/cues.ts", "src/core/ext/index.ts"]) {
			assert.equal(/from\s+"node:/.test(fs.readFileSync(f, "utf-8")), false, f);
		}
	});
});

describe("browser-safe core barrel for study", () => {
	it("exports what study needs", () => {
		assert.equal(typeof (core as Record<string, unknown>).encodeStudyContext, "function");
		assert.equal(typeof (core as Record<string, unknown>).parseStudyContext, "function");
		assert.equal(typeof (core as Record<string, unknown>).latestStudyContext, "function");
		assert.equal(typeof (core as Record<string, unknown>).pageCitations, "function");
		assert.equal(typeof (core as Record<string, unknown>).citationAt, "function");
	});
	it("the study modules behind it import nothing from node:", () => {
		for (const f of ["src/core/ext/study/context.ts"]) {
			assert.equal(/from\s+"node:/.test(fs.readFileSync(f, "utf-8")), false, f);
		}
	});
});
