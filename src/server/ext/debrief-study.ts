// src/server/ext/debrief-study.ts
/**
 * @node ext/debrief/study-feed
 * Adapts the assisted-study ledgers to the `StudyFeed` the debrief sources
 * read. Generic over the reading event type and takes the reading rule as a
 * function, so this file compiles and is tested without the study modules;
 * the live wiring passes `deriveReading(...).readPages`.
 */

import type { StudyFeed } from "./debrief-sources.ts";

const inWindow = (at: string, from: string, to: string): boolean => {
	const t = Date.parse(at);
	return Number.isFinite(t) && t >= Date.parse(from) && t <= Date.parse(to);
};

export function createStudyFeed<R extends { documentId: string; at: string }>(deps: {
	documents(): ReadonlyArray<{ id: string; title: string; chatId: string | null }>;
	reading(): readonly R[];
	links(): ReadonlyArray<{ nodeId: string; documentId: string; at: string }>;
	/** The reading rule: pages read by the given events of one document. */
	readPages(events: readonly R[], documentId: string): number[];
}): StudyFeed {
	return {
		documentOfChat(chatId) {
			const d = deps.documents().find((x) => x.chatId === chatId);
			return d ? { documentId: d.id, title: d.title } : null;
		},
		pagesRead(documentId, startedAt, endedAt) {
			return deps.readPages(deps.reading().filter((e) => e.documentId === documentId && inWindow(e.at, startedAt, endedAt)), documentId);
		},
		linkedNodeIds(documentId, startedAt, endedAt) {
			return [...new Set(deps.links().filter((l) => l.documentId === documentId && inWindow(l.at, startedAt, endedAt)).map((l) => l.nodeId))];
		},
		lastActivityAt(documentId) {
			let last: string | null = null;
			for (const e of [...deps.reading(), ...deps.links()]) {
				if (e.documentId !== documentId || !Number.isFinite(Date.parse(e.at))) continue;
				if (last === null || Date.parse(e.at) > Date.parse(last)) last = e.at;
			}
			return last;
		},
	};
}
