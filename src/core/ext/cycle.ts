// src/core/ext/cycle.ts
/**
 * One research cycle (REQ-rs-01 to REQ-rs-13). The orchestration is pure over
 * injected ports, so a scripted fake drives it in tests:
 *
 *   read marks/goals/budget -> find gaps (pure) -> for each of the best gaps:
 *   extract | verify | research(+triage+ingest) -> saturation -> watch -> log.
 *
 * Backstops: the shared daily cost gate, mark-carried depth and budget (inside
 * findGaps, and re-checked before each gap so a mark set or a budget spent
 * during the cycle is honoured), saturation, and `maxGapsPerCycle`.
 * Verification of freshly ingested nodes needs no call here: the extraction
 * pipeline is wrapped by the post-merge hook (REQ-src-13).
 *
 * Robustness rules (review carry-overs):
 *  - Everything the adapters return is untrusted: it is sanitized before it is
 *    logged or appended, so the cycle's cost is always recorded and a bad
 *    optional field can never make the log append throw.
 *  - The cycle never activates a source and never ingests model prose: the only
 *    text that reaches `deps.ingest` is `FoundSource.text` / the feed summary.
 *  - Two overlapping cycles do not both run (CycleBusyError). The guard is keyed on
 *    the `deps.log` object and, when given, on `deps.lockKey`. Tasks 8 and 13 must
 *    either pass ONE stable log object for the process or a stable `lockKey` (e.g.
 *    the data directory), because deps are rebuilt per call.
 *  - Work per cycle is bounded without prices: gaps, watch entries, sources per gap
 *    and items per watch entry all have caps (see ResearchConfig).
 *  - `GapLog.stoppedBy` (why a gap's research ended) and `CycleLogEntry.stoppedBy`
 *    (why the cycle ended) are different fields and never mixed.
 */

import type { CostGate } from "./cost-gate.ts";
import { createMarkResolver, deriveMarks, frontierMode, modeAllows, type FrontierEvent } from "./frontier.ts";
import { findGaps, type Gap } from "./gaps.ts";
import { goalScope, type Goal } from "./goals.ts";
import { ingestedEvent, normalizeLocator, triage, type InboxEvent } from "./inbox.ts";
import { DEFAULT_RESEARCH_CONFIG, type ResearchConfig } from "./research-config.ts";
import { markSpendUsd, type CycleLogEntry, type GapLog, type GapStop, type SourceLog } from "./research-log.ts";
import type {
	ChainLite,
	EventLog,
	GapError,
	GraphNodeLite,
	IngestSource,
	SourceLibraryAccess,
	UncoveredChat,
	VerificationAccess,
} from "./research-ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../settings.ts";
import { dueEntries, rankNodesByOverlap, seenItemIds, type FeedItem, type RadarAction, type RadarEvent, type Relation, type WatchEntry } from "./watch.ts";

export interface FoundSource {
	locator: string;
	title: string;
	/** The text the agent's own fetch tools returned for this locator (never model-written). */
	text: string;
}

export interface GapFinding {
	questions: string[];
	confidence: number;
	rationale: string;
	/** Why THIS GAP's research ended (not why the cycle ended). */
	stoppedBy: GapStop;
	sources: FoundSource[];
	/** Locators the agent cited but never fetched. */
	unfetched: string[];
}

export interface WatchClassification {
	relation: Relation;
	action: RadarAction;
	rationale: string;
	nearestNodeIds: string[];
}

export interface CycleDeps {
	now(): Date;
	newId(prefix: string): string;
	config: ResearchConfig;
	costGate: CostGate;
	graph(): { nodes: GraphNodeLite[]; chains: ChainLite[] };
	goals(): Goal[];
	uncovered(): UncoveredChat[];
	weakNodeIds(): string[];
	frontier: EventLog<FrontierEvent>;
	log: EventLog<CycleLogEntry>;
	/** Optional second busy-guard key (e.g. the data dir), for callers that rebuild `log` per call. */
	lockKey?: string;
	inbox: EventLog<InboxEvent>;
	radar: EventLog<RadarEvent>;
	watchlist: { read(): WatchEntry[] };
	verification: VerificationAccess;
	library: SourceLibraryAccess;
	snapshots: { put(text: string): string };
	/** Flush the not-yet-extracted prose of a chat through the upstream extraction pipeline; returns nodes added. */
	extractChat(chatId: string): Promise<number>;
	/** Notes-source path of the upstream extraction pipeline (provenance = the source); returns nodes added. */
	ingest(source: IngestSource): Promise<number>;
	/** Research one gap. The adapter records the spend itself (also when it throws); a thrown error should carry `costUsd` (see GapError) so the cycle logs it. */
	researchGap(gap: Gap, opts: { steers: string[]; sourceHunt: boolean; ref: string; maxTurns: number }): Promise<GapFinding & { costUsd: number }>;
	fetchItems(entry: WatchEntry): Promise<FeedItem[]>;
	/** May report the call's `costUsd`, summed into the cycle's cost. */
	classify(item: FeedItem, candidates: GraphNodeLite[], ref: string): Promise<WatchClassification & { costUsd?: number }>;
	/** Steering messages not yet delivered to a running agent (drained before each gap). */
	takeSteers(): string[];
	allSteers(): string[];
	isAborted(): boolean;
}

/** Another cycle is already running on the same log (in this process). */
export class CycleBusyError extends Error {
	constructor() {
		super("a research cycle is already running");
		this.name = "CycleBusyError";
	}
}

/** The injected clock does not give a valid time: nothing is started (fail closed, nothing paid). */
export class CycleClockError extends Error {
	constructor() {
		super("the clock is not valid; no research cycle was started");
		this.name = "CycleClockError";
	}
}

const MAX_WATCH_ITEMS_PER_ENTRY = 10;
const WATCH_CANDIDATES = 30;
const MAX_ERROR_CHARS = 500;
const RELATIONS = new Set<string>(["extends", "contradicts", "applies", "unrelated"]);
const GAP_STOPS = new Set<string>(["confidence", "no-more-sources", "turn-limit"]);

/** Cycles in flight, keyed on the log object and on the optional lock key. In-process only. */
const running = new WeakSet<object>();
const runningKeys = new Set<string>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
/** Money: finite and >= 0, anything else is recorded as 0. */
const usd = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
/** A count: an integer >= 0, anything else is recorded as 0. */
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
const boundedInt = (v: number, min: number, fallback: number): number => (Number.isInteger(v) && v >= min ? v : fallback);

function errorMessage(e: unknown): string {
	return (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);
}

function isConfigError(e: unknown): boolean {
	return e instanceof ModelsNotConfiguredError || e instanceof ProviderKeyMissingError;
}

function newGapLog(gap: Gap): GapLog {
	return {
		gapId: gap.id,
		type: gap.type,
		...(gap.nodeId !== undefined ? { nodeId: gap.nodeId } : {}),
		...(gap.chatId !== undefined ? { chatId: gap.chatId } : {}),
		...(gap.markId !== undefined ? { markId: gap.markId } : {}),
		questions: [],
		sources: [],
		nodesAdded: 0,
		costUsd: 0,
		saturated: false,
	};
}

export async function runCycle(deps: CycleDeps, trigger: CycleLogEntry["trigger"]): Promise<CycleLogEntry> {
	const key = isStr(deps.lockKey) && deps.lockKey !== "" ? deps.lockKey : null;
	if (running.has(deps.log) || (key !== null && runningKeys.has(key))) throw new CycleBusyError();
	running.add(deps.log);
	if (key !== null) runningKeys.add(key);
	try {
		return await runCycleUnguarded(deps, trigger);
	} finally {
		running.delete(deps.log);
		if (key !== null) runningKeys.delete(key);
	}
}

async function runCycleUnguarded(deps: CycleDeps, trigger: CycleLogEntry["trigger"]): Promise<CycleLogEntry> {
	const config = deps.config;
	const maxGaps = boundedInt(config.maxGapsPerCycle, 0, DEFAULT_RESEARCH_CONFIG.maxGapsPerCycle);
	const maxTurns = boundedInt(config.maxTurnsPerGap, 1, DEFAULT_RESEARCH_CONFIG.maxTurnsPerGap);
	const maxWatchEntries = boundedInt(config.maxWatchEntriesPerCycle, 0, DEFAULT_RESEARCH_CONFIG.maxWatchEntriesPerCycle);
	const maxSources = boundedInt(config.maxSourcesPerGap, 0, DEFAULT_RESEARCH_CONFIG.maxSourcesPerGap);

	const startDate = deps.now();
	const startMs = startDate.getTime();
	if (!Number.isFinite(startMs)) throw new CycleClockError();
	const startedAt = startDate.toISOString();
	/** A valid, non-decreasing timestamp whatever the clock does. */
	const stamp = (): string => {
		try {
			const d = deps.now();
			return Number.isFinite(d.getTime()) && d.getTime() >= startMs ? d.toISOString() : startedAt;
		} catch {
			return startedAt;
		}
	};

	const cycleId = deps.newId("cyc");
	const gapLogs: GapLog[] = [];
	const watch = { entries: 0, items: 0, ingested: 0, inbox: 0 };
	let watchNodesAdded = 0;
	let watchCostUsd = 0;
	let stoppedBy: CycleLogEntry["stoppedBy"] = "completed";

	const stopReason = (): CycleLogEntry["stoppedBy"] | null => {
		try {
			if (deps.isAborted()) return "aborted";
		} catch {
			return "aborted";
		}
		try {
			if (!deps.costGate.allowed()) return "ceiling";
		} catch {
			return "ceiling"; // a gate that cannot answer is closed
		}
		return null;
	};

	let baseSpend = new Map<string, number>();
	/** Budget spent under a mark: the log up to the cycle's start plus the gaps run since. */
	const spentUnder = (markId: string): number =>
		(baseSpend.get(markId) ?? 0) + gapLogs.reduce((n, g) => (g.markId === markId ? n + g.costUsd : n), 0);

	/** The mode now in force for nodes, from the marks as they are now (a resolver is built once per call of this). */
	const modeResolver = () => {
		const resolver = createMarkResolver(deriveMarks(deps.frontier.readAll()), deps.goals(), deps.graph().chains);
		return (nodeId: string) => {
			const mark = resolver.effective(nodeId);
			return { mark, mode: frontierMode(mark, mark === null ? 0 : spentUnder(mark.id)) };
		};
	};

	/** Ingest (active source) or propose (any other), per the triage rule (REQ-rs-07, REQ-rs-08). Null: unusable locator. */
	async function handleSource(src: IngestSource, gapId: string, foundBy: "cycle" | "watch", mayIngest: boolean, inbox: InboxEvent[]): Promise<SourceLog | null> {
		if (!isStr(src.locator)) return null;
		const locator = normalizeLocator(src.locator);
		if (locator === "") return null; // the log and the inbox reject empty locators
		const active = deps.library.isActive(src.locator) || deps.library.isActive(locator);
		const decision = triage(locator, active, inbox);
		if (decision === "skip-rejected") return { locator, outcome: "skipped-rejected", nodesAdded: 0 };
		if (decision === "skip-seen") return { locator, outcome: "skipped-seen", nodesAdded: 0 };
		const text = isStr(src.text) ? src.text : "";
		const title = isStr(src.title) ? src.title : "";
		if (decision === "ingest") {
			// A source hunt looks for sources to vet; an active one is already used by verification.
			if (!mayIngest) return { locator, outcome: "skipped-active", nodesAdded: 0 };
			if (text.trim() === "") return { locator, outcome: "failed", nodesAdded: 0 };
			let nodesAdded: number;
			try {
				nodesAdded = count(await deps.ingest({ locator, title, text }));
			} catch (e) {
				if (isConfigError(e)) throw e;
				return { locator, outcome: "failed", nodesAdded: 0 };
			}
			const event = ingestedEvent(locator, nodesAdded, stamp());
			try {
				deps.inbox.append(event);
				inbox.push(event);
			} catch {
				/* the nodes exist; a failed record only risks one repeated ingest */
			}
			return { locator, outcome: "ingested", nodesAdded: event.nodesAdded };
		}
		if (text.trim() === "") return { locator, outcome: "failed", nodesAdded: 0 };
		try {
			const snapshot = deps.snapshots.put(text);
			if (!isStr(snapshot) || snapshot === "") throw new Error("empty snapshot");
			const proposed: InboxEvent = { type: "proposed", locator, title, gapId, foundBy, cycleId, snapshot, at: stamp() };
			deps.inbox.append(proposed);
			inbox.push(proposed);
		} catch {
			return { locator, outcome: "failed", nodesAdded: 0 };
		}
		return { locator, outcome: "inbox", nodesAdded: 0 };
	}

	/** One read of the inbox serves a whole gap / watch entry; `handleSource` appends what it writes to this copy. */
	const readInbox = (): InboxEvent[] => [...deps.inbox.readAll()];

	async function sourceLine(src: IngestSource, gapId: string, foundBy: "cycle" | "watch", mayIngest: boolean, inbox: InboxEvent[]): Promise<SourceLog | null> {
		try {
			return await handleSource(src, gapId, foundBy, mayIngest, inbox);
		} catch (e) {
			if (isConfigError(e)) throw e;
			const locator = isStr(src.locator) ? normalizeLocator(src.locator) : "";
			return locator === "" ? null : { locator, outcome: "failed", nodesAdded: 0 };
		}
	}

	/** Fills `log` in place, so what was recorded before a throw (cost above all) survives it. */
	async function runGap(gap: Gap, log: GapLog): Promise<void> {
		if (gap.type === "uncovered") {
			log.nodesAdded = count(await deps.extractChat(gap.chatId!));
			return;
		}
		if (gap.type === "unverified") {
			await deps.verification.verifyNodes([gap.nodeId!]);
			return;
		}
		const sourceHunt = gap.type === "contested-no-primary";
		// Steers go to research gaps only: extraction and verification have no agent to steer.
		let steers: string[] = [];
		try {
			steers = deps.takeSteers().filter(isStr);
		} catch {
			/* no steering this gap */
		}
		let finding: Awaited<ReturnType<CycleDeps["researchGap"]>>;
		try {
			finding = await deps.researchGap(gap, { steers, sourceHunt, ref: `${cycleId}:${gap.id}`, maxTurns });
		} catch (e) {
			log.costUsd = usd((e as GapError | null)?.costUsd); // money spent before the failure (see GapError)
			throw e;
		}
		if (!isObj(finding)) throw new Error("the gap researcher returned no finding");
		log.costUsd = usd(finding.costUsd);
		log.questions = Array.isArray(finding.questions) ? finding.questions.filter(isStr) : [];
		// Optional fields: an invalid value is omitted, never allowed to fail the log append.
		if (typeof finding.confidence === "number" && finding.confidence >= 0 && finding.confidence <= 1) log.confidence = finding.confidence;
		if (isStr(finding.rationale)) log.rationale = finding.rationale;
		if (isStr(finding.stoppedBy) && GAP_STOPS.has(finding.stoppedBy)) log.stoppedBy = finding.stoppedBy;
		for (const raw of Array.isArray(finding.unfetched) ? finding.unfetched.slice(0, maxSources) : []) {
			const locator = isStr(raw) ? normalizeLocator(raw) : "";
			if (locator !== "") log.sources.push({ locator, outcome: "not-fetched", nodesAdded: 0 });
		}
		const inbox = readInbox();
		for (const src of Array.isArray(finding.sources) ? finding.sources.slice(0, maxSources) : []) {
			if (!isObj(src)) continue;
			let line: SourceLog | null;
			try {
				line = await sourceLine(src as unknown as IngestSource, gap.id, "cycle", !sourceHunt, inbox);
			} catch (e) {
				if (isConfigError(e)) throw e;
				continue;
			}
			if (line === null) continue;
			log.sources.push(line);
			log.nodesAdded += line.nodesAdded;
		}
		const ingested = log.sources.filter((s) => s.outcome === "ingested").length;
		if (!sourceHunt && ingested >= 1 && log.nodesAdded < config.saturationMinNodes && gap.nodeId !== undefined) {
			// REQ-rs-06: too little new material for this node -> hold it, unless the user already marked it.
			if (modeResolver()(gap.nodeId).mark?.author !== "user") {
				deps.frontier.append({
					type: "set",
					markId: `mark_saturated_${gap.nodeId}`,
					scope: { kind: "node", id: gap.nodeId },
					mark: "hold",
					note: "saturated",
					author: "agent",
					at: stamp(),
				});
				log.saturated = true;
			}
		}
	}

	async function runWatch(): Promise<void> {
		const radarAtStart = deps.radar.readAll();
		const lastChecked = new Map<string, number>();
		for (const e of radarAtStart) {
			const t = e.type === "checked" ? Date.parse(e.at) : Number.NaN;
			if (!Number.isNaN(t) && t > (lastChecked.get(e.entryId) ?? Number.NEGATIVE_INFINITY)) lastChecked.set(e.entryId, t);
		}
		// Oldest-checked first (never checked first); Array.sort is stable, so ties keep list order.
		const due = dueEntries(deps.watchlist.read(), radarAtStart, stamp()).sort(
			(a, b) => (lastChecked.get(a.id) ?? Number.NEGATIVE_INFINITY) - (lastChecked.get(b.id) ?? Number.NEGATIVE_INFINITY) || 0,
		);
		for (const entry of due) {
			if (watch.entries >= maxWatchEntries) return; // entries skipped below do not count
			if (stopReason() !== null) return;
			const { nodes, chains } = deps.graph();
			const goals = deps.goals().filter((g) => g.status === "active" && (entry.goalId === undefined || g.id === entry.goalId));
			const scope = new Set(goals.flatMap((g) => goalScope(g.targetNodeIds, chains)));
			// Stop/hold marks keep a region out of watch ingestion too (it is expansion).
			const modeOf = modeResolver();
			const allowed = new Set([...scope].filter((id) => modeAllows(modeOf(id).mode, "expansion")));
			if (scope.size > 0 && allowed.size === 0) continue; // nothing to compare against right now: look again later
			const scoped = nodes.filter((n) => allowed.has(n.id));
			watch.entries++;
			let items: FeedItem[];
			try {
				items = await deps.fetchItems(entry);
			} catch {
				deps.radar.append({ type: "checked", entryId: entry.id, ok: false, items: 0, at: stamp() });
				continue;
			}
			const seen = seenItemIds(deps.radar.readAll(), entry.id);
			const inbox = readInbox();
			const fresh = items.filter((i) => !seen.has(i.id)).slice(0, MAX_WATCH_ITEMS_PER_ENTRY);
			for (const item of fresh) {
				if (stopReason() !== null) break;
				watch.items++;
				const candidates = rankNodesByOverlap(`${item.title} ${item.summary}`, scoped, WATCH_CANDIDATES);
				let verdict: WatchClassification;
				if (candidates.length === 0) {
					verdict = { relation: "unrelated", action: "ignore", rationale: "no word overlap with the nodes in scope", nearestNodeIds: [] };
				} else {
					try {
						const raw = await deps.classify(item, candidates, `${cycleId}:watch:${entry.id}`);
						watchCostUsd += usd(raw?.costUsd);
						const ids = new Set(candidates.map((c) => c.id));
						verdict = {
							relation: isStr(raw?.relation) && RELATIONS.has(raw.relation) ? raw.relation : "unrelated",
							action: raw?.action === "ingest" ? "ingest" : "ignore",
							rationale: isStr(raw?.rationale) ? raw.rationale : "",
							nearestNodeIds: Array.isArray(raw?.nearestNodeIds) ? raw.nearestNodeIds.filter((id) => isStr(id) && ids.has(id)) : [],
						};
					} catch (e) {
						if (isConfigError(e)) throw e;
						continue; // not recorded: the item is tried again at the next check
					}
				}
				try {
					deps.radar.append({
						type: "classified",
						entryId: entry.id,
						itemId: item.id,
						title: item.title,
						link: item.link,
						nearestNodeIds: verdict.nearestNodeIds,
						relation: verdict.relation,
						action: verdict.action,
						rationale: verdict.rationale,
						at: stamp(),
					});
				} catch {
					continue;
				}
				if (verdict.action !== "ingest") continue;
				const text = `# ${item.title}\n\nSource: ${item.link}\n\n${item.summary}`;
				const line = await sourceLine({ locator: item.link, title: item.title, text }, `watch:${entry.id}`, "watch", true, inbox);
				if (line === null) continue;
				if (line.outcome === "ingested") {
					watch.ingested++;
					watchNodesAdded += line.nodesAdded;
				}
				if (line.outcome === "inbox") watch.inbox++;
			}
			deps.radar.append({ type: "checked", entryId: entry.id, ok: true, items: fresh.length, at: stamp() });
		}
	}

	try {
		const early = stopReason();
		if (early !== null) {
			stoppedBy = early;
		} else {
			const { nodes, chains } = deps.graph();
			baseSpend = markSpendUsd(deps.log.readAll());
			const gaps = findGaps({
				goals: deps.goals(),
				chains,
				nodes,
				trust: deps.verification.trustOf(nodes.map((n) => n.id)),
				weakNodeIds: deps.weakNodeIds(),
				uncovered: deps.uncovered(),
				marks: deriveMarks(deps.frontier.readAll()),
				markSpendUsd: baseSpend,
				config,
			}).slice(0, maxGaps);
			if (gaps.length === 0) stoppedBy = "no-gaps";
			for (const gap of gaps) {
				const stop = stopReason();
				if (stop !== null) {
					stoppedBy = stop;
					break;
				}
				const log = newGapLog(gap);
				try {
					// A mark set (or a budget spent) since the gaps were found still applies.
					if (gap.nodeId !== undefined && !modeAllows(modeResolver()(gap.nodeId).mode, gap.class)) continue;
					await runGap(gap, log);
					gapLogs.push(log);
				} catch (e) {
					log.error = errorMessage(e);
					gapLogs.push(log);
					if (isConfigError(e)) {
						stoppedBy = "error";
						break;
					}
				}
			}
			if (stoppedBy === "completed" || stoppedBy === "no-gaps") {
				try {
					await runWatch();
					const stop = stopReason();
					if (stop !== null) stoppedBy = stop;
				} catch (e) {
					if (!isConfigError(e)) throw e;
					stoppedBy = "error";
				}
			}
		}
	} catch (e) {
		stoppedBy = "error";
		gapLogs.push({ gapId: "cycle", type: "uncovered", questions: [], sources: [], nodesAdded: 0, costUsd: 0, saturated: false, error: errorMessage(e) });
	}

	let steers: string[] = [];
	try {
		steers = deps.allSteers().filter(isStr);
	} catch {
		/* the log simply carries no steers */
	}
	const endedAt = stamp();
	const entry: CycleLogEntry = {
		type: "cycle",
		cycleId,
		trigger,
		startedAt,
		endedAt,
		stoppedBy,
		gaps: gapLogs,
		watch,
		nodesAdded: gapLogs.reduce((n, g) => n + g.nodesAdded, 0) + watchNodesAdded,
		costUsd: gapLogs.reduce((n, g) => n + g.costUsd, 0) + watchCostUsd,
		steers,
	};
	try {
		deps.log.append(entry);
	} catch {
		// Money may already be spent: record at least the cost and the counts, without any optional text.
		try {
			deps.log.append({
				...entry,
				gaps: entry.gaps.map((g) => ({
					gapId: g.gapId,
					type: g.type,
					...(g.markId !== undefined ? { markId: g.markId } : {}),
					questions: [],
					sources: g.sources.filter((s) => s.locator !== ""),
					nodesAdded: g.nodesAdded,
					costUsd: g.costUsd,
					saturated: g.saturated,
				})),
				steers: [],
			});
		} catch {
			/* the log is unwritable: the caller still gets the entry */
		}
	}
	return entry;
}
