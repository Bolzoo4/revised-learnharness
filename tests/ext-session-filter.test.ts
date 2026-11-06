import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionMatchesFilter } from "../src/core/ext/practice/session-kind.ts";

const KINDS = [undefined, "teach", "practice", "review", "office_hours", "study", "research"] as const;
const listed = (filter: "teach" | "all" | "practice") => KINDS.filter((k) => sessionMatchesFilter(k, filter));

test("teaching lists teach (also the default kind) and study", () => {
	assert.deepEqual(listed("teach"), [undefined, "teach", "study"]);
});
test("practice lists practice, review and office hours, not study", () => {
	assert.deepEqual(listed("practice"), ["practice", "review", "office_hours"]);
});
test("all lists everything except research", () => {
	assert.deepEqual(listed("all"), [undefined, "teach", "practice", "review", "office_hours", "study"]);
});
test("research is listed under no filter", () => {
	for (const f of ["teach", "practice", "all"] as const) assert.equal(sessionMatchesFilter("research", f), false);
});
