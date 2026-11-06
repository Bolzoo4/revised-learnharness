// src/server/ext/research-service.ts
/**
 * The research loop's runtime (REQ-rs-01, REQ-rs-16): one cycle at a time, the
 * scheduler tick, abort and steering. The cycle's log and lock key come from
 * `deps.store` (the one research store of the data dir); the service never
 * builds a second one, so the busy guard in runCycle always sees the same log.
 * Everything else arrives through `deps`, so fakes drive it in tests;
 * research-live.ts wires the real ones.
 *
 * Failure rules: `start` answers with a fixed reason and never carries an
 * error text. A CycleBusyError or CycleClockError from runCycle is handled
 * here and never leaves the service; any other failure goes to `onError`.
 */

import { MAX_STEER_CHARS } from "../../agent/ext/research-tools.ts";
import { CycleBusyError, CycleClockError, isCycleRunning, runCycle, type CycleDeps } from "../../core/ext/cycle.ts";
import { createCycleControl, type CycleControl } from "../../core/ext/cycle-control.ts";
import { cycleDue, type CycleLogEntry } from "../../core/ext/research-log.ts";
import type { EventLog } from "../../core/ext/research-ports.ts";
import { ResearchInputError } from "./research-errors.ts";

/** Steering messages one cycle accepts; the learner's steers are bounded per cycle as well as in length. */
export const MAX_STEERS_PER_CYCLE = 50;

export type RunTrigger = CycleLogEntry["trigger"];
export type StartResult =
	| { started: true }
	| { started: false; reason: "already-running" | "not-configured" | "clock-invalid" | "provider-limit" };

export interface ResearchStatus {
	running: boolean;
	trigger?: RunTrigger;
	startedAt?: string;
	steers: string[];
	lastCycle: CycleLogEntry | null;
	/** ISO time the provider usage-limit pause ends, while one is in force; null otherwise. */
	providerPausedUntil: string | null;
}

/** The cycle's ports, minus the parts the service owns (log, lock key, abort and steering handles). */
export type CycleBuildDeps = Omit<CycleDeps, "log" | "lockKey" | "isAborted" | "takeSteers" | "allSteers">;

export interface ResearchServiceDeps {
	store: { log: EventLog<CycleLogEntry>; lockKey: string };
	/** Builds the cycle's ports around this run's control handle (the agent adapter attaches its live agent to it). */
	buildCycleDeps(control: CycleControl): CycleBuildDeps;
	cycleHours: number;
	/** False when no model is configured: the scheduler stays quiet instead of failing every cycle. */
	canRun(): boolean;
	/** The provider usage-limit pause in force, if any (ISO end time). No cycle starts while one is. */
	providerPause?(): { pausedUntil: string } | null;
	now(): Date;
	onError?(err: unknown): void;
}

interface Run {
	control: CycleControl;
	trigger: RunTrigger;
	startedAt: string;
	done: Promise<void>;
}

/** The clock as an ISO time, or null when it does not give a valid instant. */
function clockIso(now: () => Date): string | null {
	try {
		const d = now();
		return Number.isFinite(d.getTime()) ? d.toISOString() : null;
	} catch {
		return null;
	}
}

export function createResearchService(deps: ResearchServiceDeps) {
	let current: Run | null = null;

	const report = (err: unknown): void => {
		try {
			deps.onError?.(err);
		} catch {
			/* a broken error hook must not break the service */
		}
	};

	const pausedUntil = (): string | null => {
		try {
			return deps.providerPause?.()?.pausedUntil ?? null;
		} catch {
			return null; // a pause that cannot be read is treated as none; the gate still refuses each call
		}
	};

	function start(trigger: RunTrigger): StartResult {
		if (current !== null || isCycleRunning(deps.store.log, deps.store.lockKey)) return { started: false, reason: "already-running" };
		if (!deps.canRun()) return { started: false, reason: "not-configured" };
		if (pausedUntil() !== null) return { started: false, reason: "provider-limit" };
		const startedAt = clockIso(deps.now);
		if (startedAt === null) return { started: false, reason: "clock-invalid" };

		const control = createCycleControl();
		let built: CycleBuildDeps;
		try {
			built = deps.buildCycleDeps(control);
		} catch (e) {
			report(e);
			return { started: false, reason: "not-configured" };
		}
		const cycleDeps: CycleDeps = {
			...built,
			log: deps.store.log,
			lockKey: deps.store.lockKey,
			isAborted: () => control.isAborted(),
			takeSteers: () => control.takeSteers(),
			// No gap is left to steer once the gap phase is over (the watch phase included).
			onGapsDone: () => control.closeSteering(),
			onError: (err) => report(err),
			allSteers: () => control.allSteers(),
			// The live agent is attached per gap by the researcher; it is detached as soon as that gap settles.
			researchGap: async (gap, opts) => {
				try {
					return await built.researchGap(gap, opts);
				} finally {
					control.attach(null);
				}
			},
		};

		const run: Run = { control, trigger, startedAt, done: Promise.resolve() };
		current = run;
		run.done = runCycle(cycleDeps, trigger)
			.then(
				() => undefined,
				(err: unknown) => {
					if (!(err instanceof CycleBusyError) && !(err instanceof CycleClockError)) report(err);
				},
			)
			.finally(() => {
				control.attach(null);
				if (current === run) current = null;
			});
		return { started: true };
	}

	return {
		start,

		/** Called by the scheduler on an interval: starts a `schedule` cycle when one is due. Null when none is. */
		tick(): StartResult | null {
			if (current !== null || !deps.canRun() || pausedUntil() !== null) return null;
			const now = clockIso(deps.now);
			if (now === null) return null;
			return cycleDue(deps.store.log.readAll(), now, deps.cycleHours) ? start("schedule") : null;
		},

		status(): ResearchStatus {
			const log = deps.store.log.readAll();
			const lastCycle = log.length === 0 ? null : log[log.length - 1]!;
			const providerPausedUntil = pausedUntil();
			if (current === null) return { running: false, steers: [], lastCycle, providerPausedUntil };
			return {
				running: true,
				trigger: current.trigger,
				startedAt: current.startedAt,
				steers: current.control.allSteers(),
				lastCycle,
				providerPausedUntil,
			};
		},

		/** null when no cycle runs. A message that is empty, too long, beyond the cycle's steer cap, or sent after the gap phase is refused. */
		steer(message: string): "delivered" | "queued" | null {
			const text = typeof message === "string" ? message.trim() : "";
			if (text === "" || text.length > MAX_STEER_CHARS) throw new ResearchInputError(`a steering message is 1 to ${MAX_STEER_CHARS} characters`);
			if (current === null) return null;
			if (current.control.allSteers().length >= MAX_STEERS_PER_CYCLE) throw new ResearchInputError("this cycle has enough steering messages");
			const result = current.control.steer(text);
			if (result === "closed") throw new ResearchInputError("the cycle has no gap left to steer");
			return result;
		},

		/** True when a running cycle was asked to stop; false when none runs (or it was already asked). */
		abort(): boolean {
			if (current === null || current.control.isAborted()) return false;
			current.control.abort();
			return true;
		},

		/** Resolves when the running cycle (if any) has finished. */
		idle: (): Promise<void> => current?.done ?? Promise.resolve(),
	};
}

export type ResearchService = ReturnType<typeof createResearchService>;
