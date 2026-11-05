// src/core/ext/cycle-control.ts
/**
 * The handle a running cycle shares with the outside world: abort and steering
 * (REQ-rs-16). A steering message goes straight to the live agent attached for
 * the current gap (`Agent.steer`, "delivered"); between gaps there is no live
 * agent, so it waits in one queue and is handed to the next gap's prompt
 * ("queued"). Once the gap phase is over no gap will open a prompt again, so
 * steering is closed and a further steer is refused ("closed"), never queued.
 * Every accepted steer is also kept for the cycle's log. Pure.
 */

export interface SteerableAgent {
	steer(message: { role: "user"; content: string; timestamp: number }): void;
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
}

export function createCycleControl(now: () => number = Date.now): CycleControl {
	const controller = new AbortController();
	const queued: string[] = [];
	const all: string[] = [];
	let agent: SteerableAgent | null = null;
	let open = true;
	return {
		signal: controller.signal,
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
