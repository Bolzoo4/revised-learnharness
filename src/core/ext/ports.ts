/**
 * Storage ports of the extension layer (same hexagonal rule as
 * src/core/ports.ts: core codes against these types, adapters live in
 * src/store/ext/, wiring happens once in src/server/ext/stores.ts).
 */

import type { GoalEvent } from "./goals.ts";

export interface GoalsStore {
	/** Throws if the event is invalid. */
	appendEvent(event: GoalEvent): void;
	/** Valid events in append order. */
	readEvents(): GoalEvent[];
}
