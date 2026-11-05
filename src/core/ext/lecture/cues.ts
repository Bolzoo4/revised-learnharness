// src/core/ext/lecture/cues.ts
/**
 * Cue-synchronised highlighting (REQ-lec-09): the speech engine reports the
 * character offset being spoken (`boundary` events); the active cue is the
 * last one at or before that offset.
 */

import type { Cue } from "./lecture.ts";

export function activeCue(cues: readonly Cue[], charIndex: number): Cue | null {
	let best: Cue | null = null;
	for (const c of cues) if (c.atChar <= charIndex && (best === null || c.atChar >= best.atChar)) best = c;
	return best;
}
