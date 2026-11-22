/**
 * The teaching gate (REQ-graph-agent-19/20): before the teacher's next turn,
 * wait for the previous turn's extraction — at most TEACHING_GATE_TIMEOUT_MS.
 *
 * Pure: the timer is injected, so no real timers live in core. The server
 * seam supplies the real setTimeout/clearTimeout.
 */

/** The wait cap: teaching is never blocked longer than this. */
export const TEACHING_GATE_TIMEOUT_MS = 60_000;

/** The injected clock. `handle` is opaque to the gate. */
export interface GateTimer {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type GateStatus = "none" | "done" | "timeout" | "failed";

/**
 * Wait for `pending` (an in-flight extraction) to settle, bounded by the
 * timer. Never throws: a rejection is "failed", a stall past the cap is
 * "timeout". The timer is always cleared once the race is decided.
 */
export async function awaitExtraction(
	pending: Promise<unknown> | null,
	opts: { timeoutMs: number; timer: GateTimer },
): Promise<{ status: GateStatus }> {
	if (pending === null) return { status: "none" };
	let handle: unknown;
	const timedOut = new Promise<GateStatus>((resolve) => {
		handle = opts.timer.setTimeout(() => resolve("timeout"), opts.timeoutMs);
	});
	const settled = pending.then(
		(): GateStatus => "done",
		(): GateStatus => "failed",
	);
	try {
		return { status: await Promise.race([settled, timedOut]) };
	} finally {
		opts.timer.clearTimeout(handle);
	}
}
