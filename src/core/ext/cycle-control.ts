// src/core/ext/cycle-control.ts
/**
 * The handle a running cycle shares with the outside world: abort and steering
 * (REQ-rs-16). A steering message goes straight to the live agent attached for
 * the current gap (`Agent.steer`, "delivered"); between gaps there is no live
 * agent, so it waits in one queue and is handed to the next gap's prompt
 * ("queued"). Every steer is also kept for the cycle's log. Pure.
 */

export interface SteerableAgent {
	steer(message: { role: "user"; content: string; timestamp: number }): void;
}

export interface CycleControl {
	readonly signal: AbortSignal;
	abort(): void;
	isAborted(): boolean;
	/** "delivered" reached a live agent; "queued" will open the next gap's prompt. */
	steer(message: string): "delivered" | "queued";
	/** Steering not yet delivered to any agent; draining it hands it to the caller. */
	takeSteers(): string[];
	/** Every steer of this cycle, delivered or queued, in order. */
	allSteers(): string[];
	/** The agent of the gap now running (null between gaps). */
	attach(agent: SteerableAgent | null): void;
}

export function createCycleControl(now: () => number = Date.now): CycleControl {
	const controller = new AbortController();
	const queued: string[] = [];
	const all: string[] = [];
	let agent: SteerableAgent | null = null;
	return {
		signal: controller.signal,
		abort: () => controller.abort(),
		isAborted: () => controller.signal.aborted,
		steer(message) {
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
