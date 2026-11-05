// src/core/ext/practice/office-hours.ts
/**
 * office-hours.jsonl: the designated source of an office-hours session and
 * every verdict given. Keyed by chat id (the session is a chat of kind
 * `office_hours`). The conversation itself lives in the chat record.
 */

import { parseVerdictItem, type VerdictItem, type VerdictOutcome } from "./verdict.ts";

export type OfficeHoursEvent =
	| {
			type: "designated";
			chatId: string;
			/** Human label of the source ("Solutions manual, ch. 3", "Exercise ex_1 reference"). */
			label: string;
			/** Snapshot of the source text (data/ext/snapshots/<sha256>.txt). */
			sha256: string;
			/** Set when the session grades an exercise. */
			exercise?: { setId: string; exerciseId: string };
			at: string;
	  }
	| { type: "verdict"; chatId: string; outcome: VerdictOutcome; items: VerdictItem[]; discarded: number; at: string };

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseOfficeHoursEvent(raw: unknown): OfficeHoursEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (!isStr(r.chatId) || !isStr(r.at)) return null;
	if (r.type === "designated") {
		if (!isStr(r.label) || !/^[0-9a-f]{64}$/.test(String(r.sha256))) return null;
		const ex = r.exercise as { setId?: unknown; exerciseId?: unknown } | undefined;
		if (ex !== undefined && (!isStr(ex.setId) || !isStr(ex.exerciseId))) return null;
		return {
			type: "designated",
			chatId: r.chatId,
			label: r.label,
			sha256: r.sha256 as string,
			...(ex ? { exercise: { setId: ex.setId as string, exerciseId: ex.exerciseId as string } } : {}),
			at: r.at,
		};
	}
	if (r.type === "verdict") {
		if (r.outcome !== "consistent" && r.outcome !== "differs" && r.outcome !== "not_verifiable") return null;
		if (!Array.isArray(r.items) || typeof r.discarded !== "number") return null;
		const items: VerdictItem[] = [];
		for (const i of r.items) {
			const p = parseVerdictItem(i);
			if (p === null) return null;
			items.push(p);
		}
		return { type: "verdict", chatId: r.chatId, outcome: r.outcome, items, discarded: r.discarded, at: r.at };
	}
	return null;
}

export type Designation = Extract<OfficeHoursEvent, { type: "designated" }>;

/** The latest designation of a session, or null. */
export function designationOf(events: readonly OfficeHoursEvent[], chatId: string): Designation | null {
	let found: Designation | null = null;
	for (const e of events) if (e.type === "designated" && e.chatId === chatId) found = e;
	return found;
}
