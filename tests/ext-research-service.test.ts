// tests/ext-research-service.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCycleControl, type CycleControl } from "../src/core/ext/cycle-control.ts";
import { createResearchService, type CycleBuildDeps } from "../src/server/ext/research-service.ts";
import { createResearchAdmin } from "../src/server/ext/research-admin.ts";
import { ResearchInputError } from "../src/server/ext/research-errors.ts";
import { DEFAULT_RESEARCH_CONFIG } from "../src/core/ext/research-config.ts";
import { fakeDeps, finding, memLog } from "./helpers/research-fakes.ts";
import type { GapFinding } from "../src/core/ext/cycle.ts";
import type { CycleLogEntry } from "../src/core/ext/research-log.ts";
import type { RadarEvent, WatchEntry } from "../src/core/ext/watch.ts";
import type { FrontierEvent } from "../src/core/ext/frontier.ts";
import type { InboxEvent } from "../src/core/ext/inbox.ts";

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

	it("after closeSteering a steer is refused and is not kept in the cycle's log", () => {
		const c = createCycleControl();
		assert.equal(c.steer("before"), "queued");
		c.closeSteering();
		assert.equal(c.steer("after"), "closed");
		assert.deepEqual(c.allSteers(), ["before"]);
	});
});

type GapFn = (control: CycleControl, opts: { steers: string[] }) => Promise<GapFinding & { costUsd: number }>;

const watchEntry: WatchEntry = { id: "w1", kind: "arxiv-query", query: "gradients", cadenceHours: 24 };
const feedItem = { id: "i1", title: "Gradients paper", link: "https://arxiv.org/abs/i1", summary: "gradients explained" };

/** A service over a fresh fake store. `gap` is the researcher for every gap; it gets the cycle's control handle and the gap's steers. */
function harness(opts: { gap?: GapFn; canRun?: () => boolean; nowMs?: () => number; onError?: (e: unknown) => void; build?: (control: CycleControl) => never; over?: Partial<CycleBuildDeps> } = {}) {
	const f = fakeDeps();
	let clock = Date.parse("2026-11-04T12:00:00.000Z");
	let seq = 0;
	const errors: unknown[] = [];
	const store = { log: f.deps.log, lockKey: `test-lock-${++seq}` };
	const service = createResearchService({
		store,
		buildCycleDeps: (control) => {
			if (opts.build) opts.build(control);
			return { ...f.deps, ...opts.over, researchGap: async (_gap, o) => (opts.gap ?? (async () => finding()))(control, o) };
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

/**
 * Holds the watch phase open (inside fetchItems) until `release` is called, so a steer can be sent during it.
 * It also lets go by itself after 1.5 s, so a failing assertion ends the test instead of hanging the run.
 */
function holdWatch() {
	let reached!: () => void;
	const inWatch = new Promise<void>((r) => (reached = r));
	let release!: () => void;
	const hold = new Promise<void>((r) => {
		release = r;
		setTimeout(r, 1500);
	});
	return { inWatch, release, over: { watchlist: { read: () => [watchEntry] }, fetchItems: async () => (reached(), await hold, []) } };
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
		// The cycle has ended: its control is closed, so a late steer is refused rather than queued.
		assert.equal(seen.steer("after the gap"), "closed");
		assert.deepEqual(delivered, Array(gaps).fill("while live"));
	});

	it("a steer between two gaps is queued, and a steer while the next gap's agent is attached is delivered", async () => {
		const delivered: string[] = [];
		const agent = { steer: (m: { content: string }) => void delivered.push(m.content) };
		const verdicts: string[] = [];
		let call = 0;
		const h = harness({
			gap: async (control) => {
				const n = ++call;
				if (n === 1) {
					control.attach(agent); // gap 1: its agent is live, so the steer is delivered
					verdicts.push(`gap1 ${control.steer("in gap 1")}`);
				} else {
					// gap 1 has settled and detached its agent: nothing is live yet
					verdicts.push(`gap2 before attach ${h.service.steer("between")}`);
					control.attach(agent);
					verdicts.push(`gap2 attached ${control.steer("live")}`);
				}
				return finding();
			},
		});
		h.service.start("manual");
		await h.service.idle();
		assert.equal(call, 2, "the default fixture has two research gaps");
		assert.deepEqual(verdicts, ["gap1 delivered", "gap2 before attach queued", "gap2 attached delivered"]);
		assert.deepEqual(delivered, ["in gap 1", "live"]);
		assert.deepEqual(h.log.readAll()[0]!.steers, ["in gap 1", "between", "live"]);
	});

	it("a steer during the watch phase is refused, not queued: no gap is left to steer", async () => {
		const w = holdWatch();
		const h = harness({ over: w.over });
		h.service.start("manual");
		await w.inWatch;
		try {
			assert.throws(() => h.service.steer("during the watch"), ResearchInputError);
		} finally {
			w.release();
		}
		await h.service.idle();
		assert.deepEqual(h.log.readAll()[0]!.steers, []);
	});

	it("a steer after the gap limit is reached is refused, before the watch too", async () => {
		const w = holdWatch();
		const h = harness({ over: { ...w.over, config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 } } });
		h.service.start("manual");
		await w.inWatch;
		try {
			assert.throws(() => h.service.steer("one gap was all"), ResearchInputError);
		} finally {
			w.release();
		}
		await h.service.idle();
		assert.equal(h.log.readAll()[0]!.gaps.length, 1);
	});

	it("an abort right after start means no research gap is called", async () => {
		let calls = 0;
		const h = harness({ gap: async () => (calls++, finding()) });
		h.service.start("manual");
		assert.equal(h.service.abort(), true);
		await h.service.idle();
		assert.equal(calls, 0);
		assert.equal(h.log.readAll()[0]!.stoppedBy, "aborted");
	});

	it("abort stops the cycle before the next gap", async () => {
		const { service, log } = harness();
		service.start("manual");
		assert.equal(service.abort(), true);
		await service.idle();
		assert.equal(log.readAll()[0]!.stoppedBy, "aborted");
		assert.equal(service.abort(), false);
	});

	it("a raw error text from a gap or from the classifier never reaches the log, the status or the admin reads", async () => {
		let classified = false;
		const h = harness({
			gap: async () => {
				throw new Error("secret gap detail");
			},
			over: {
				config: { ...DEFAULT_RESEARCH_CONFIG, maxGapsPerCycle: 1 },
				watchlist: { read: () => [watchEntry] },
				fetchItems: async () => [feedItem],
				classify: async () => {
					classified = true;
					throw new Error("secret classify detail");
				},
			},
		});
		h.service.start("manual");
		await h.service.idle();
		assert.equal(classified, true);
		const frontier = memLog<FrontierEvent>();
		const radar = memLog<RadarEvent>();
		const admin = createResearchAdmin({
			frontier,
			log: h.log,
			radar,
			watchlist: { read: () => [], write: () => {} },
			inboxService: { inbox: memLog<InboxEvent>(), snapshots: { get: () => null }, library: { activate: () => {} }, ingest: async () => 0, now: () => new Date() },
			newId: () => "id",
			now: () => new Date("2026-11-04T12:00:00.000Z"),
		});
		const everything = JSON.stringify([h.log.readAll(), h.service.status(), admin.readLog(20)]);
		assert.doesNotMatch(everything, /secret/);
		assert.deepEqual(h.errors.map((e) => (e as Error).message), ["secret gap detail"]);
	});

	it("the gap's raw error reaches onError and the log keeps only the fixed label", async () => {
		const h = harness({
			gap: async () => {
				throw new Error("secret gap detail");
			},
		});
		h.service.start("manual");
		await h.service.idle();
		const entry: CycleLogEntry = h.log.readAll()[0]!;
		assert.equal(entry.gaps[0]!.error, "the gap failed");
		assert.doesNotMatch(JSON.stringify(entry), /secret/);
		assert.ok(entry.gaps.length >= 1 && entry.gaps.every((g) => g.error === "the gap failed"));
		assert.ok(h.errors.length === entry.gaps.length && h.errors.every((e) => (e as Error).message === "secret gap detail"));
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
