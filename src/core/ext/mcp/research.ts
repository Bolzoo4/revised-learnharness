// src/core/ext/mcp/research.ts
/**
 * research_status (REQ-mcp-05): frontier marks, inbox size, a summary of the
 * last cycle. Allow-listed: no source locator, question, rationale, error text
 * or steering message leaves the server.
 */

import { deriveMarks } from "../frontier.ts";
import { deriveInbox } from "../inbox.ts";
import type { Call } from "./call.ts";
import { instantMs } from "./input.ts";
import { capText, finiteOrNull, LIMITS, page } from "./limits.ts";

export function researchStatus(call: Call) {
	const marks = deriveMarks(call.deps.frontier.readAll()).sort((a, b) => instantMs(b.at) - instantMs(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const marksPage = page(marks, LIMITS.marksMax);

	const inbox = { pending: 0, approved: 0, rejected: 0, activated: 0, total: 0 };
	for (const item of deriveInbox(call.deps.inbox.readAll())) {
		inbox[item.status] += 1;
		inbox.total += 1;
	}

	let last = null as ReturnType<typeof call.deps.researchLog.readAll>[number] | null;
	for (const entry of call.deps.researchLog.readAll()) {
		if (last === null || instantMs(entry.endedAt) >= instantMs(last.endedAt)) last = entry;
	}

	return {
		frontier: {
			...marksPage,
			items: marksPage.items.map((m) => ({
				id: capText(m.id, LIMITS.idMaxChars),
				scope: { kind: m.scope.kind, id: capText(m.scope.id, LIMITS.idMaxChars) },
				mark: m.mark,
				maxDepth: finiteOrNull(m.maxDepth),
				budgetUsd: finiteOrNull(m.budgetUsd),
				note: capText(m.note, LIMITS.noteChars),
				author: m.author,
				at: m.at,
			})),
		},
		inbox,
		lastCycle:
			last === null
				? null
				: {
						cycleId: capText(last.cycleId, LIMITS.idMaxChars),
						trigger: last.trigger,
						startedAt: last.startedAt,
						endedAt: last.endedAt,
						stoppedBy: last.stoppedBy,
						gaps: last.gaps.length,
						nodesAdded: last.nodesAdded,
						costUsd: finiteOrNull(last.costUsd),
						watch: last.watch,
					},
	};
}
