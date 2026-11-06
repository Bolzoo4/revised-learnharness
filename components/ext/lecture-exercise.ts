// components/ext/lecture-exercise.ts
/**
 * Which exercise a step of the lecture player completes (REQ-deb-03, lecture facts).
 * Pure, so the player's rules are tested without a DOM (see the player for the wiring).
 */

export interface PlayedBlock {
	id: string;
	role: string;
}

/** The countdown of an exercise reached zero: the exercise is done, also on the last block (where the lecture then stops). */
export function exerciseDoneAtZero(block: PlayedBlock | undefined, remaining: number | null): string | null {
	return block?.role === "exercise" && remaining === 0 ? block.id : null;
}

/**
 * The learner moves forward (Next or Done) out of an exercise whose countdown is still running.
 * No countdown yet, a countdown already at zero (recorded by exerciseDoneAtZero), or a move backwards: nothing.
 */
export function exerciseDoneOnLeave(block: PlayedBlock | undefined, remaining: number | null, from: number, to: number): string | null {
	if (block?.role !== "exercise" || !(remaining !== null && remaining > 0) || to <= from) return null;
	return block.id;
}
