// tests/ext-exams-types.test.ts
// Compile-time check: the Exams pages' mirrored record shapes equal the contract in src/core/ext/exams/types.ts.
// A drift makes `npm run typecheck` fail here. The runtime assertion is a placeholder so the file runs as a test.
import assert from "node:assert/strict";
import { it } from "node:test";
import type * as Contract from "../src/core/ext/exams/types.ts";
import type * as Mirror from "../components/ext/exams-types.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameShapes: [
	Same<Mirror.Collection, Contract.Collection>,
	Same<Mirror.ExamDoc, Contract.ExamDoc>,
	Same<Mirror.Exercise, Contract.Exercise>,
	Same<Mirror.MaterialDoc, Contract.MaterialDoc>,
] = [true, true, true, true];

it("the mirrored exam shapes match the contract", () => {
	assert.deepEqual(sameShapes, [true, true, true, true]);
});
