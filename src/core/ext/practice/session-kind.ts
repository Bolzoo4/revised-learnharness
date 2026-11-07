// src/core/ext/practice/session-kind.ts
import type { ChatKind } from "../../contracts/chat.ts";

/**
 * Sessions that write nothing to the graph and compact like practice:
 * `practice` plus the extension's `review`, `office_hours`, `research` and `study` kinds.
 * The single definition; layers import it instead of re-testing the kinds.
 */
export const isPracticeLike = (kind: ChatKind | string | undefined): boolean =>
	kind === "practice" || kind === "review" || kind === "office_hours" || kind === "research" || kind === "study";

export type SessionListFilter = "teach" | "all" | "practice";

/**
 * Which sessions the sidebar lists under each filter. A research session is a
 * background-agent conversation: it is never listed, not even under "all". A study
 * session is a reading companion for the learner's own PDF, not a conversation to
 * browse: it lists only under "all". Review and office-hours sessions list under
 * "practice"; plain teaching sessions under "teach".
 */
export function sessionMatchesFilter(kind: ChatKind | string | undefined, filter: SessionListFilter): boolean {
	const k = kind ?? "teach";
	if (k === "research") return false;
	if (filter === "all") return true;
	if (filter === "teach") return k === "teach";
	return isPracticeLike(k) && k !== "study";
}
