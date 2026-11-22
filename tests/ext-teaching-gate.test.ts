/**
 * The teaching gate's pure core (REQ-graph-agent-19/20): the wait for an
 * in-flight extraction, bounded by an injected timer. No real timers here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { awaitExtraction, TEACHING_GATE_TIMEOUT_MS, type GateTimer } from "../src/core/ext/teaching-gate.ts";

function fakeTimer() {
	const armed: { ms: number; fn: () => void; cleared: boolean }[] = [];
	const timer: GateTimer = {
		setTimeout(fn, ms) {
			const t = { ms, fn, cleared: false };
			armed.push(t);
			return t;
		},
		clearTimeout(handle) {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	return { timer, armed };
}

function deferred<T = unknown>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe("teaching gate: awaitExtraction (pure, injected timer)", () => {
	it("the cap is 60 seconds", () => {
		assert.equal(TEACHING_GATE_TIMEOUT_MS, 60_000);
	});

	it("a null pending resolves none immediately and arms no timer", async () => {
		const { timer, armed } = fakeTimer();
		const out = await awaitExtraction(null, { timeoutMs: 60_000, timer });
		assert.deepEqual(out, { status: "none" });
		assert.equal(armed.length, 0);
	});

	it("resolves done when the extraction settles before the timeout, and clears the timer", async () => {
		const { timer, armed } = fakeTimer();
		const run = deferred();
		const pending = awaitExtraction(run.promise, { timeoutMs: 60_000, timer });
		run.resolve({ nodes: 2, chains: 1 });
		assert.deepEqual(await pending, { status: "done" });
		assert.equal(armed.length, 1);
		assert.equal(armed[0]!.cleared, true, "the timer is cleared on early settle");
	});

	it("times out at exactly 60000 ms when the extraction never settles", async () => {
		const { timer, armed } = fakeTimer();
		const pending = awaitExtraction(new Promise(() => {}), { timeoutMs: TEACHING_GATE_TIMEOUT_MS, timer });
		assert.equal(armed.length, 1);
		assert.equal(armed[0]!.ms, 60_000, "the timer was armed for exactly 60000 ms");
		armed[0]!.fn();
		assert.deepEqual(await pending, { status: "timeout" });
	});

	it("a rejecting extraction resolves failed and never throws", async () => {
		const { timer, armed } = fakeTimer();
		const out = await awaitExtraction(Promise.reject(new Error("extractor down")), { timeoutMs: 60_000, timer });
		assert.deepEqual(out, { status: "failed" });
		assert.equal(armed[0]!.cleared, true, "the timer is cleared on failure too");
	});

	it("a timer firing after an early settle has no effect on the result", async () => {
		const { timer, armed } = fakeTimer();
		const run = deferred();
		const pending = awaitExtraction(run.promise, { timeoutMs: 60_000, timer });
		run.resolve(undefined);
		const out = await pending;
		armed[0]!.fn();
		assert.deepEqual(out, { status: "done" });
	});
});
