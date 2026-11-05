// tests/ext-research-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCycleControl, type CycleControl } from "../src/core/ext/cycle-control.ts";
import { createResearchService } from "../src/server/ext/research-service.ts";
import { ResearchInputError } from "../src/server/ext/research-errors.ts";
import { fakeDeps, finding } from "./helpers/research-fakes.ts";
import type { GapFinding } from "../src/core/ext/cycle.ts";

describe("cycle control", () => {
	it("steering reaches the live agent immediately and is queued between gaps", () => {
		const got: string[] = [];
		const c = createCycleControl(() => 42);
		assert.equal(c.steer("early"), "queued");
		c.attach({ steer: (m) => void got.push(`${m.role}:${m.content}@${m.timestamp}`) });
		assert.equal(c.steer("live"), "delivered");
		assert.deepEqual(got, ["user:live@42"]);
		assert.deepEqual(c.takeSteers(), ["early"]);
		assert.deepEqual(c.takeSteers(), []);
		assert.deepEqual(c.allSteers(), ["early", "live"]);
		c.attach(null);
		assert.equal(c.steer("late"), "queued");
		assert.deepEqual(c.takeSteers(), ["late"]);
	});

	it("a live agent that refuses the steer gets it queued instead of losing it", () => {
		const c = createCycleControl();
		c.attach({
			steer: () => {
				throw new Error("agent ended");
			},
		});
		assert.equal(c.steer("kept"), "queued");
		assert.deepEqual(c.takeSteers(), ["kept"]);
	});

	it("abort flips the signal", () => {
		const c = createCycleControl();
		assert.equal(c.isAborted(), false);
		c.abort();
		assert.deepEqual([c.isAborted(), c.signal.aborted], [true, true]);
	});
});

/** A service over a fresh fake store. `gap` is the researcher for every gap; it gets the cycle's control handle. */
function harness(opts: { gap?: (control: CycleControl) => Promise<GapFinding & { costUsd: number }>; canRun?: () => boolean; nowMs?: () => number; onError?: (e: unknown) => void; build?: (control: CycleControl) => never } = {}) {
	const f = fakeDeps();
	let clock = Date.parse("2026-11-04T12:00:00.000Z");
	let seq = 0;
	const errors: unknown[] = [];
	const store = { log: f.deps.log, lockKey: `test-lock-${++seq}` };
	const service = createResearchService({
		store,
		buildCycleDeps: (control) => {
			if (opts.build) opts.build(control);
			return { ...f.deps, researchGap: async () => (opts.gap ?? (async () => finding()))(control) };
		},
		cycleHours: 6,
		canRun: opts.canRun ?? (() => true),
		now: () => new Date(opts.nowMs ? opts.nowMs() : clock),
		onError: (e) => {
			errors.push(e);
			opts.onError?.(e);
		},
	});
	return {
		service,
		store,
		log: f.deps.log,
		errors,
		advanceHours: (h: number) => void (clock += h * 3_600_000),
	};
}

describe("research service", () => {
	it("runs one cycle at a time and logs it", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const { service, log } = harness({ gap: async () => (await hold, finding()) });
		assert.deepEqual(service.start("manual"), { started: true });
		assert.deepEqual(service.start("manual"), { started: false, reason: "already-running" });
		assert.equal(service.status().running, true);
		release();
		await service.idle();
		assert.equal(service.status().running, false);
		assert.equal(log.readAll().length, 1);
		assert.equal(service.status().lastCycle?.trigger, "manual");
	});

	it("two services on one store cannot run two cycles (single-flight on the store)", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const a = harness({ gap: async () => (await hold, finding()) });
		const b = createResearchService({
			store: a.store,
			buildCycleDeps: () => fakeDeps().deps,
			cycleHours: 6,
			canRun: () => true,
			now: () => new Date("2026-11-04T12:00:00.000Z"),
		});
		assert.deepEqual(a.service.start("manual"), { started: true });
		assert.deepEqual(b.start("manual"), { started: false, reason: "already-running" });
		release();
		await a.service.idle();
		assert.deepEqual(b.start("manual"), { started: true });
		await b.idle();
	});

	it("steers a running cycle and records the message in the log (REQ-rs-16)", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const { service, log } = harness({ gap: async () => (await hold, finding()) });
		assert.equal(service.steer("nothing runs"), null);
		service.start("manual");
		assert.equal(service.steer("focus on proofs"), "queued");
		release();
		await service.idle();
		assert.deepEqual(log.readAll()[0]!.steers, ["focus on proofs"]);
	});

	it("bounds steering: empty and over-long messages are refused, the count per cycle is capped", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => (release = r));
		const { service } = harness({ gap: async () => (await hold, finding()) });
		assert.throws(() => service.steer("   "), ResearchInputError);
		assert.throws(() => service.steer("x".repeat(2001)), ResearchInputError);
		assert.equal(service.steer("x".repeat(2000)), null);
		service.start("manual");
		for (let i = 0; i < 50; i++) assert.equal(service.steer(`s${i}`), "queued");
		assert.throws(() => service.steer("one too many"), ResearchInputError);
		release();
		await service.idle();
	});

	it("the live agent is detached when each gap settles, even on error (REQ-rs-16)", async () => {
		const delivered: string[] = [];
		const agent = { steer: (m: { content: string }) => void delivered.push(m.content) };
		let seen!: CycleControl;
		const { service, log } = harness({
			gap: async (control) => {
				seen = control;
				control.attach(agent);
				assert.equal(control.steer("while live"), "delivered");
				throw new Error("the research failed");
			},
		});
		service.start("manual");
		await service.idle();
		const gaps = log.readAll()[0]!.gaps.length;
		assert.ok(gaps >= 1);
		// Each gap attached the agent once and steered it once; no later steer reaches a settled agent.
		assert.deepEqual(delivered, Array(gaps).fill("while live"));
		assert.equal(seen.steer("after the gap"), "queued");
		assert.deepEqual(delivered, Array(gaps).fill("while live"));
	});

	it("abort stops the cycle before the next gap", async () => {
		const { service, log } = harness();
		service.start("manual");
		assert.equal(service.abort(), true);
		await service.idle();
		assert.equal(log.readAll()[0]!.stoppedBy, "aborted");
		assert.equal(service.abort(), false);
	});

	it("refuses to start without a configured model", () => {
		const { service, log } = harness({ canRun: () => false });
		assert.deepEqual(service.start("manual"), { started: false, reason: "not-configured" });
		assert.equal(service.tick(), null);
		assert.equal(log.readAll().length, 0);
	});

	it("an invalid clock starts nothing and says so with a fixed reason", () => {
		const { service, log } = harness({ nowMs: () => Number.NaN });
		assert.deepEqual(service.start("manual"), { started: false, reason: "clock-invalid" });
		assert.equal(service.tick(), null);
		assert.equal(log.readAll().length, 0);
	});

	it("a failing cycle build is reported to onError and answered with a fixed reason only", () => {
		const { service, errors } = harness({
			build: () => {
				throw new Error("secret detail of the model settings");
			},
		});
		const result = service.start("manual");
		assert.deepEqual(result, { started: false, reason: "not-configured" });
		assert.doesNotMatch(JSON.stringify(result), /secret/);
		assert.equal(errors.length, 1);
	});

	it("tick starts a cycle when none ran, then waits for the cadence (REQ-rs-01)", async () => {
		const { service, advanceHours, log } = harness();
		assert.deepEqual(service.tick(), { started: true });
		await service.idle();
		assert.equal(service.tick(), null);
		advanceHours(3);
		assert.equal(service.tick(), null);
		advanceHours(4);
		assert.deepEqual(service.tick(), { started: true });
		await service.idle();
		assert.deepEqual(
			log.readAll().map((e) => e.trigger),
			["schedule", "schedule"],
		);
	});
});
