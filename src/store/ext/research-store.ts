// src/store/ext/research-store.ts
import fs from "node:fs";
import path from "node:path";
import { parseFrontierEvent, type FrontierEvent } from "../../core/ext/frontier.ts";
import { parseInboxEvent, type InboxEvent } from "../../core/ext/inbox.ts";
import type { EventLog } from "../../core/ext/research-ports.ts";
import { parseCycleLogEntry, type CycleLogEntry } from "../../core/ext/research-log.ts";
import { parseRadarEvent, parseWatchEntry, type RadarEvent, type WatchEntry } from "../../core/ext/watch.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";
import { createLedger } from "./ledger.ts";
import { createSnapshotStore } from "./snapshot-store.ts";

/**
 * The research loop's four ledgers (each `createLedger`, REQ-port-01), its watchlist file and its
 * snapshot writer.
 *
 * Every member is built ONCE here and the result is frozen: `runCycle`'s busy guard is keyed on the
 * identity of `deps.log`, so callers must create ONE store per data dir (the composition root does)
 * and may pass `store.lockKey` as the cycle's second guard key.
 */
export function createResearchStore(dir: string) {
	const ledger = <T>(file: string, parse: (raw: unknown) => T | null, view: (all: T[]) => T[] = (all) => all): EventLog<T> => {
		const l = createLedger(dir, file, parse);
		return { append: (e) => l.append(e), readAll: () => view(l.readAll()) };
	};
	const watchFile = path.join(dir, "watchlist.json");
	const snapshotStore = createSnapshotStore(dir);
	return Object.freeze({
		/** Stable identity of this data dir, for the cycle's busy guard. */
		lockKey: path.resolve(dir),
		frontier: ledger<FrontierEvent>("frontier.jsonl", parseFrontierEvent),
		/** A repeated `cycleId` is ignored on read: the first entry wins (cost is never counted twice). */
		log: ledger<CycleLogEntry>("research-log.jsonl", parseCycleLogEntry, (all) => {
			const seen = new Set<string>();
			return all.filter((e) => !seen.has(e.cycleId) && seen.add(e.cycleId));
		}),
		inbox: ledger<InboxEvent>("inbox.jsonl", parseInboxEvent),
		radar: ledger<RadarEvent>("radar.jsonl", parseRadarEvent),
		watchlist: Object.freeze({
			/** [] when absent or corrupt; invalid entries and repeated ids are dropped. Throws on a newer stamp. */
			read(): WatchEntry[] {
				assertExtFormat(dir);
				let doc: unknown;
				try {
					doc = JSON.parse(fs.readFileSync(watchFile, "utf-8"));
				} catch {
					return [];
				}
				const list = typeof doc === "object" && doc !== null ? (doc as { entries?: unknown }).entries : undefined;
				if (!Array.isArray(list)) return [];
				const seen = new Set<string>();
				const out: WatchEntry[] = [];
				for (const item of list) {
					const e = parseWatchEntry(item);
					if (e === null || seen.has(e.id)) continue;
					seen.add(e.id);
					out.push(e);
				}
				return out;
			},
			/** Replaces the whole list. Throws (and writes nothing) on an invalid entry or a repeated id: nothing is dropped silently. */
			write(entries: readonly WatchEntry[]): void {
				assertExtFormat(dir);
				const seen = new Set<string>();
				const clean: WatchEntry[] = [];
				for (const raw of entries) {
					const e = parseWatchEntry(raw);
					if (e === null) throw new Error("watchlist: invalid entry");
					if (seen.has(e.id)) throw new Error(`watchlist: duplicate id ${e.id}`);
					seen.add(e.id);
					clean.push(e);
				}
				ensureExtFormat(dir);
				writeFileAtomicSync(watchFile, JSON.stringify({ entries: clean }, null, "\t") + "\n", { allowInPlaceFallback: true });
			},
		}),
		/** Source-text snapshots, content-addressed like every snapshot (read back with the shared snapshot reader). */
		snapshots: Object.freeze({
			/** Returns the sha256. Throws on non-string or blank text, writing nothing. */
			put(text: string): string {
				if (typeof text !== "string" || text.trim() === "") throw new Error("snapshot: empty text");
				return snapshotStore.put(text);
			},
		}),
	});
}

export type ResearchStore = ReturnType<typeof createResearchStore>;
