// src/core/ext/cycle-control.ts
/**
 * The handle a running cycle shares with the outside world: abort and steering
 * (REQ-rs-16). A steering message goes straight to the live agent attached for
 * the current gap (`Agent.steer`, "delivered"); between gaps there is no live
 * agent, so it waits in one queue and is handed to the next gap's prompt
 * ("queued"). Once the gap phase is over no gap will open a prompt again, so
 * steering is closed and a further steer is refused ("closed"), never queued.
 * Every accepted steer is also kept for the cycle's log. Pure.
 *
 * The same handle keeps the cycle's progress reports (REQ-rs-20): short texts the
 * research agent writes every few steps, shown on the page while the cycle runs
 * and kept in the log. Bounded: the newest MAX_REPORTS are kept.
 *
 * It also holds the bounds of what a learner may give a cycle: a research goal
 * (REQ-rs-19) and the length of a progress report.
 */

export interface SteerableAgent {
	steer(message: { role: "user"; content: string; timestamp: number }): void;
}

/** A research goal, in characters after trimming (REQ-rs-19). */
export const MAX_GOAL_CHARS = 500;
/** One progress report, in characters after trimming (REQ-rs-20). */
export const MAX_REPORT_CHARS = 400;
/** Progress reports kept per cycle; the oldest go first. */
export const MAX_REPORTS = 50;

/**
 * A goal as the learner sent it. Absent or blank is no goal (`goal` undefined);
 * anything that is not text, or a goal over MAX_GOAL_CHARS after trimming, is refused.
 */
export function cleanGoal(raw: unknown): { ok: true; goal: string | undefined } | { ok: false } {
	if (raw === undefined) return { ok: true, goal: undefined };
	if (typeof raw !== "string") return { ok: false };
	const text = raw.trim();
	if (text === "") return { ok: true, goal: undefined };
	return text.length > MAX_GOAL_CHARS ? { ok: false } : { ok: true, goal: text };
}

export interface CycleControl {
	readonly signal: AbortSignal;
	abort(): void;
	isAborted(): boolean;
	/** "delivered" reached a live agent; "queued" will open the next gap's prompt; "closed" was refused (no gap is left). */
	steer(message: string): "delivered" | "queued" | "closed";
	/** The gap phase is over: steering is refused from now on. */
	closeSteering(): void;
	/** Steering not yet delivered to any agent; draining it hands it to the caller. */
	takeSteers(): string[];
	/** Every steer of this cycle, delivered or queued, in order. */
	allSteers(): string[];
	/** The agent of the gap now running (null between gaps). */
	attach(agent: SteerableAgent | null): void;
	/** A progress report (trimmed). False when refused: empty, not text, or over MAX_REPORT_CHARS. */
	progress(text: string): boolean;
	/** The kept progress reports, oldest first (a copy). */
	reports(): string[];
}

export function createCycleControl(now: () => number = Date.now): CycleControl {
	const controller = new AbortController();
	const queued: string[] = [];
	const all: string[] = [];
	const kept: string[] = [];
	let agent: SteerableAgent | null = null;
	let open = true;
	return {
		signal: controller.signal,
		progress(text) {
			if (typeof text !== "string") return false;
			const clean = text.trim();
			if (clean === "" || clean.length > MAX_REPORT_CHARS) return false;
			kept.push(clean);
			if (kept.length > MAX_REPORTS) kept.splice(0, kept.length - MAX_REPORTS);
			return true;
		},
		reports: () => [...kept],
		abort: () => controller.abort(),
		isAborted: () => controller.signal.aborted,
		closeSteering: () => {
			open = false;
		},
		steer(message) {
			if (!open) return "closed";
			all.push(message);
			if (agent !== null) {
				try {
					agent.steer({ role: "user", content: message, timestamp: now() });
					return "delivered";
				} catch {
					/* the agent has ended: the message waits for the next gap instead of being lost */
				}
			}
			queued.push(message);
			return "queued";
		},
		takeSteers: () => queued.splice(0),
		allSteers: () => [...all],
		attach(a) {
			agent = a;
		},
	};
}
