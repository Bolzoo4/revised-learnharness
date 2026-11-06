// src/core/ext/mcp/debriefs.ts
/**
 * get_recent_debriefs (REQ-mcp-13): session debriefs and the latest weekly
 * synthesis, from the app's own recentDebriefs reader (first event per key
 * wins, newest first). Facts are a computed object; they are kept only when
 * small, otherwise replaced by a marker, so one entry cannot fill the response.
 */

import { recentDebriefs, SESSION_KINDS, type JournalEvent } from "../debrief/journal.ts";
import type { Call } from "./call.ts";
import { optionalEnum, parseInstant } from "./input.ts";
import { capText, clampLimit, fitToBudget, LIMITS, page } from "./limits.ts";

const KINDS = [...SESSION_KINDS, "weekly"] as const;

function entry(e: JournalEvent) {
	const factsText = JSON.stringify(e.facts);
	const small = factsText !== undefined && Buffer.byteLength(factsText, "utf-8") <= LIMITS.factsBytes;
	return {
		id: capText(e.id, LIMITS.idMaxChars),
		kind: e.kind,
		sessionKind: e.sessionKind,
		weekOf: e.weekOf,
		at: e.at,
		facts: small ? e.facts : { kind: e.facts.kind, omitted: "facts exceed the size limit" },
		commentary: e.commentary === null ? null : capText(e.commentary, LIMITS.commentaryChars),
		nullReason: e.nullReason,
	};
}

export function getRecentDebriefs(call: Call, input: Record<string, unknown>) {
	const limit = clampLimit(input.limit, LIMITS.debriefsDefault, LIMITS.debriefsMax);
	const kind = optionalEnum(input.kind, KINDS, "kind");
	const since = input.since === undefined ? undefined : parseInstant(input.since, "since");
	const journal = call.deps.journal.readAll();
	// The reader reports truncation against its own limit; ask for one more to know whether more exist.
	const found = recentDebriefs(journal, { limit: Math.min(limit + 1, LIMITS.debriefsMax + 1), kind, since });
	const debriefs = page(found.entries, limit);
	const weekly = recentDebriefs(journal, { limit: 1, kind: "weekly" }).entries[0];
	const items = fitToBudget({ ...debriefs, items: debriefs.items.map(entry) }, LIMITS.listBudgetBytes);
	return { debriefs: items, latestWeekly: weekly === undefined ? null : entry(weekly) };
}
