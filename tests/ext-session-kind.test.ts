import assert from "node:assert/strict";
import { test } from "node:test";
import { isPracticeLike } from "../src/core/index.ts";

test("isPracticeLike: practice, review and office_hours are practice-like", () => {
	for (const k of ["practice", "review", "office_hours"]) assert.equal(isPracticeLike(k), true, k);
});

test("isPracticeLike: teach, absent and unknown kinds are not", () => {
	for (const k of ["teach", undefined, "", "other"]) assert.equal(isPracticeLike(k), false, String(k));
});
