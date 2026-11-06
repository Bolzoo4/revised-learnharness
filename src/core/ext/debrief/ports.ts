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

export interface DebriefWriter {
	/**
	 * One commentary for the given facts. Throws WriterUnavailableError when no
	 * model is configured (the caller defers and tries again later) and any other
	 * error for a failed call.
	 */
	write(request: WriterRequest): Promise<{ commentary: Commentary; costUsd: number; styleVersion: string }>;
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
