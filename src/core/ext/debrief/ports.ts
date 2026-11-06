// src/core/ext/debrief/ports.ts
/**
 * @node ext/debrief/ports
 * The seams of the debrief service. The agent layer implements
 * `DebriefWriter`; the server layer implements `DebriefSources`.
 */

import type { Commentary } from "./commentary.ts";
import type { SessionFacts } from "./facts.ts";
import type { SessionRef } from "./sessions.ts";
import type { WeeklyFacts, WeeklyWindow } from "./weekly.ts";

export type WriterRequest =
	| { kind: "session"; facts: SessionFacts; title: string }
	| { kind: "weekly"; facts: WeeklyFacts };

/**
 * What the service gives the writer for one run. The writer reports the cost
 * of every billed model step through `onSpend` as the step completes, and asks
 * `allowed` before each new model step: a closed gate (or a failed spend
 * record, which cancels the run) must stop the run before the next provider call.
 */
export interface WriterControl {
	onSpend(usd: number): void;
	allowed(): boolean;
	/** Aborted when the run is cancelled. */
	signal: AbortSignal;
}

export interface DebriefWriter {
	/**
	 * One commentary for the given facts. Throws WriterUnavailableError when no
	 * model is configured (the caller defers and tries again later), an
	 * AbortError when the run was cancelled, and any other error for a failed call.
	 * `costUsd` is the total of the run; the service records only what `onSpend` did not.
	 * Without a control (a direct call) nothing is recorded and no gate applies.
	 */
	write(request: WriterRequest, control?: WriterControl): Promise<{ commentary: Commentary; costUsd: number; styleVersion: string }>;
}

/** No model or key is configured: not a failure of the debrief, nothing is stored. */
export class WriterUnavailableError extends Error {
	constructor(message = "no model is configured for debriefs") {
		super(message);
		this.name = "WriterUnavailableError";
	}
}

export interface DebriefSources {
	/** Every session the extension can see (any state). */
	sessions(): SessionRef[];
	/** Facts of one session as of `endedAt`. Reads only. */
	sessionFacts(ref: SessionRef, endedAt: string): SessionFacts;
	/** Facts of one week. Reads only. */
	weeklyFacts(window: WeeklyWindow): WeeklyFacts;
}
