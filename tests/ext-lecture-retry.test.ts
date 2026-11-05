import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateWithFeedback } from "../src/core/ext/lecture/retry.ts";

const feedback = (errors: string[]): string => errors.join("|");

describe("generateWithFeedback", () => {
	it("returns the first valid attempt without feedback", async () => {
		const seen: (string | null)[] = [];
		const r = await generateWithFeedback({ attempt: async (f) => (seen.push(f), 1), validate: () => [], feedback, maxRetries: 2 });
		assert.deepEqual(r, { ok: true, value: 1, attempts: 1 });
		assert.deepEqual(seen, [null]);
	});
	it("retries with the previous errors as feedback and stops at success", async () => {
		const seen: (string | null)[] = [];
		let n = 0;
		const r = await generateWithFeedback({
			attempt: async (f) => (seen.push(f), ++n),
			validate: (v) => (v < 3 ? [`bad${v}`] : []),
			feedback,
			maxRetries: 2,
		});
		assert.deepEqual(r, { ok: true, value: 3, attempts: 3 });
		assert.deepEqual(seen, [null, "bad1", "bad2"]);
	});
	it("gives up after exactly maxRetries retries", async () => {
		let n = 0;
		const r = await generateWithFeedback({ attempt: async () => ++n, validate: () => ["no"], feedback, maxRetries: 2 });
		assert.equal(n, 3);
		assert.deepEqual(r, { ok: false, value: 3, errors: ["no"], attempts: 3 });
	});
	it("does not swallow errors thrown by the attempt", async () => {
		await assert.rejects(
			generateWithFeedback({ attempt: async () => { throw new Error("aborted"); }, validate: () => [], feedback, maxRetries: 2 }),
			/aborted/,
		);
	});
});
