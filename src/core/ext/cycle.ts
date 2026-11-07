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
 *  - A provider usage limit (CostGate.reason() === "provider-limit") is not a failure:
 *    the cycle stops with stoppedBy "provider-limit", the gap that hit it is not
 *    logged as failed, and no later gap or watch entry starts while the pause holds.
 *  - The log stores only fixed error labels (GAP_FAILED, WATCH_FAILED, CYCLE_FAILED).
 *    The raw error goes to `deps.onError` and nowhere else.
 *  - `deps.onGapsDone` runs once when the research-gap phase is over, before the
 *    watch: a steer after it has no gap left to reach and must be refused.
 *  - A goal cycle (REQ-rs-19) researches the goal as its one gap, chosen instead of
 *    the graph's gaps, and runs no watch. Its goal and the progress reports the
 *    agent wrote (REQ-rs-20) are recorded in the log entry.
 */

import type { CostGate } from "./cost-gate.ts";
import { createMarkResolver, deriveMarks, frontierMode, modeAllows, type FrontierEvent } from "./frontier.ts";
import { findGaps, goalGap, type Gap } from "./gaps.ts";
import { cleanGoal, MAX_REPORTS, MAX_REPORT_CHARS } from "./cycle-control.ts";
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
	/** Locators the agent fetched but whose text is not capturable (cut by the tool, or past the byte budget). Logged, never ingested. */
	notCapturable?: string[];
	/** Locators the agent fetched but the finding did not keep (over the source cap). Logged, never ingested. */
	capped?: string[];
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
	/** Research one gap. The researcher records each model call's spend through the shared CostGate itself; the adapter must NOT record it again. A thrown error should carry `costUsd` (see GapError) so the cycle logs it. */
	researchGap(gap: Gap, opts: { steers: string[]; sourceHunt: boolean; ref: string; maxTurns: number }): Promise<GapFinding & { costUsd: number }>;
	fetchItems(entry: WatchEntry): Promise<FeedItem[]>;
	/** May report the call's `costUsd`, summed into the cycle's cost. */
	classify(item: FeedItem, candidates: GraphNodeLite[], ref: string): Promise<WatchClassification & { costUsd?: number }>;
	/** Steering messages not yet delivered to a running agent (drained before each gap). */
	takeSteers(): string[];
	allSteers(): string[];
	/** Progress reports of the run, oldest first (REQ-rs-20). Absent or throwing: the log carries none. */
	allReports?(): string[];
	isAborted(): boolean;
	/** Called once when the research-gap phase is over (the last gap settled, or it was cut short). Its throws are ignored. */
	onGapsDone?(): void;
	/** Receives the raw error of a failed gap, watch or cycle. The log keeps only the fixed labels. Its throws are ignored. */
	onError?(err: unknown): void;
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
/** The only error texts the log stores: the raw error never leaves the cycle through the log. */
const GAP_FAILED = "the gap failed";
const WATCH_FAILED = "the watch failed";
const CYCLE_FAILED = "the cycle failed";
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

/** What a cycle is run for: a learner's research goal (REQ-rs-19), or nothing (the graph chooses). */
export interface CycleScope {
	/** Already trimmed and bounded (cleanGoal). Undefined: a graph cycle. */
	goal?: string;
}

export async function runCycle(deps: CycleDeps, trigger: CycleLogEntry["trigger"], scope: CycleScope = {}): Promise<CycleLogEntry> {
	const key = isStr(deps.lockKey) && deps.lockKey !== "" ? deps.lockKey : null;
	if (running.has(deps.log) || (key !== null && runningKeys.has(key))) throw new CycleBusyError();
	running.add(deps.log);
	if (key !== null) runningKeys.add(key);
	try {
		return await runCycleUnguarded(deps, trigger, scope);
	} finally {
		running.delete(deps.log);
		if (key !== null) runningKeys.delete(key);
	}
}

/** True while a cycle runs on this log (or lock key) in this process. Synchronous, so a caller can refuse a second start before it begins. */
export function isCycleRunning(log: object, lockKey?: string): boolean {
	const key = isStr(lockKey) && lockKey !== "" ? lockKey : null;
	return running.has(log) || (key !== null && runningKeys.has(key));
}

/** The progress reports the run gave, bounded like the handle keeps them; a failing hook gives none. */
function readReports(read: CycleDeps["allReports"]): string[] {
	try {
		const list = read?.();
		if (!Array.isArray(list)) return [];
		return list.filter((r): r is string => isStr(r) && r.trim() !== "" && r.length <= MAX_REPORT_CHARS).slice(-MAX_REPORTS);
	} catch {
		return [];
	}
}

async function runCycleUnguarded(deps: CycleDeps, trigger: CycleLogEntry["trigger"], scope: CycleScope): Promise<CycleLogEntry> {
	const config = deps.config;
	const goalParsed = cleanGoal(scope.goal);
	if (!goalParsed.ok) throw new Error("invalid research goal");
	const goal = goalParsed.goal;
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

	/** The raw error goes to the hook only; a broken hook never breaks the cycle. */
	const report = (e: unknown): void => {
		try {
			deps.onError?.(e);
		} catch {
			/* ignored: the cycle's record does not depend on the hook */
		}
	};
	let gapsDone = false;
	/** Once per cycle, when no research gap is left to run (CycleDeps.onGapsDone). */
	const finishGaps = (): void => {
		if (gapsDone) return;
		gapsDone = true;
		try {
			deps.onGapsDone?.();
		} catch {
			/* ignored: the cycle goes on without the hook */
		}
	};

	/** True when the gate is closed by a provider usage limit (not by the ceiling). */
	const providerLimited = (): boolean => {
		try {
			return deps.costGate.reason?.() === "provider-limit";
		} catch {
			return false;
		}
	};

	const stopReason = (): CycleLogEntry["stoppedBy"] | null => {
		try {
			if (deps.isAborted()) return "aborted";
		} catch {
			return "aborted";
		}
		try {
			if (!deps.costGate.allowed()) return providerLimited() ? "provider-limit" : "ceiling";
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
			// The ceiling is checked before EACH ingest (REQ-cost-01): a gap's spend can close it mid-gap.
			const refused = stopReason();
			if (refused === "ceiling" || refused === "provider-limit") return { locator, outcome: "failed", nodesAdded: 0 };
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
		for (const raw of Array.isArray(finding.notCapturable) ? finding.notCapturable.slice(0, maxSources) : []) {
			const locator = isStr(raw) ? normalizeLocator(raw) : "";
			if (locator !== "") log.sources.push({ locator, outcome: "not-capturable", nodesAdded: 0 });
		}
		for (const raw of Array.isArray(finding.capped) ? finding.capped.slice(0, maxSources) : []) {
			const locator = isStr(raw) ? normalizeLocator(raw) : "";
			if (locator !== "") log.sources.push({ locator, outcome: "over-cap", nodesAdded: 0 });
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
						watchCostUsd += usd((e as { costUsd?: unknown } | null)?.costUsd); // spend of a failed classification is real
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
		// Yield once, so an abort called right after the cycle started is seen before the first gap.
		await Promise.resolve();
		const early = stopReason();
		if (early !== null) {
			stoppedBy = early;
			finishGaps();
		} else {
			const { nodes, chains } = deps.graph();
			baseSpend = markSpendUsd(deps.log.readAll());
			// A goal cycle researches only its goal (REQ-rs-19); a graph cycle chooses the best gaps (REQ-rs-02).
			const gaps: Gap[] =
				goal !== undefined
					? [goalGap(goal, `goal:${cycleId}`)]
					: findGaps({
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
					if (providerLimited()) {
						// Not a failure: the spend so far is kept, the gap is left for a later cycle.
						if (log.costUsd > 0) gapLogs.push(log);
						stoppedBy = "provider-limit";
						break;
					}
					report(e);
					log.error = GAP_FAILED;
					gapLogs.push(log);
					if (isConfigError(e)) {
						stoppedBy = "error";
						break;
					}
				}
			}
			finishGaps();
			// A goal cycle has no watch: its one gap is the whole run.
			if ((stoppedBy === "completed" || stoppedBy === "no-gaps") && goal === undefined) {
				try {
					await runWatch();
					const stop = stopReason();
					if (stop !== null) stoppedBy = stop;
				} catch (e) {
					if (!isConfigError(e)) throw e;
					report(e);
					gapLogs.push({ gapId: "watch", type: "uncovered", questions: [], sources: [], nodesAdded: 0, costUsd: 0, saturated: false, error: WATCH_FAILED });
					stoppedBy = "error";
				}
			}
		}
	} catch (e) {
		stoppedBy = "error";
		finishGaps();
		report(e);
		gapLogs.push({ gapId: "cycle", type: "uncovered", questions: [], sources: [], nodesAdded: 0, costUsd: 0, saturated: false, error: CYCLE_FAILED });
	}

	let steers: string[] = [];
	try {
		steers = deps.allSteers().filter(isStr);
	} catch {
		/* the log simply carries no steers */
	}
	const endedAt = stamp();
	const reports = readReports(deps.allReports);
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
		...(goal !== undefined ? { goal } : {}),
		...(reports.length > 0 ? { reports } : {}),
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
					...(g.error !== undefined ? { error: g.error } : {}),
				})),
				steers: [],
				reports: [],
			});
		} catch {
			/* the log is unwritable: the caller still gets the entry */
		}
	}
	return entry;
}
