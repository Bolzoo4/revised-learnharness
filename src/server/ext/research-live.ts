// src/server/ext/research-live.ts
/**
 * Autonomous Research Loop live wiring and touchpoints (REQ-rs-01, REQ-rs-15, REQ-rs-16).
 *
 * Singletons for production:
 * - researchAdmin: administrative levers (marks, watchlist, inbox decisions, log reads)
 * - researchService: runtime loop (single cycle flight, scheduler tick, steering)
 * - researchToolContext: tool context for the research agent chat session
 * - startResearchSession: chat of kind "research"
 * - startResearchScheduler: periodic ticker (inert under test)
 *
 * Adapters:
 * - makeResearchGap: wraps gap-research subagent with live steering, cost gating, and agent attachment
 * - makeClassify: wraps watch-classify agent with cost gating and abort signal
 */

import crypto from "node:crypto";
import { createGapResearcher, type GapBrief, type GapResearchHooks } from "../../agent/ext/gap-research.ts";
import { createResearchAgent } from "../../agent/ext/research-agent.ts";
import type { ResearchToolContext } from "../../agent/ext/research-tools.ts";
import { createWatchClassifier, type WatchClassifyHooks, type WatchClassifyResult } from "../../agent/ext/watch-classify.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { coverageOf } from "../../core/coverage.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import type { CycleControl } from "../../core/ext/cycle-control.ts";
import type { FoundSource, GapFinding, WatchClassification } from "../../core/ext/cycle.ts";
import { deriveGoals } from "../../core/ext/goals.ts";
import type { Gap } from "../../core/ext/gaps.ts";
import { sourceFilePath, type InboxItem } from "../../core/ext/inbox.ts";
import { emit } from "../../core/events.ts";
import { isPracticeLike } from "../../core/ext/practice/session-kind.ts";
import { researchConfigFromEnv, type ResearchConfig } from "../../core/ext/research-config.ts";
import type { ChainLite, GraphNodeLite, IngestSource, LibraryEntryInput, TrustInfo, UncoveredChat } from "../../core/ext/research-ports.ts";
import { matchSource } from "../../core/ext/sources.ts";
import { deriveTrustMap } from "../../core/ext/trust.ts";
import type { FeedItem, WatchEntry } from "../../core/ext/watch.ts";
import { weakPremiseNodeIds } from "../../core/ext/weak-premises.ts";
import { getGraph } from "../../core/graph.ts";
import { ROLE_SLOT, ModelsNotConfiguredError, ProviderKeyMissingError } from "../../core/settings.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { searchProvider } from "../search.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createResearchAdmin } from "./research-admin.ts";
import { createResearchService } from "./research-service.ts";
import { extStores } from "./stores.ts";
import { addLibrarySource, setLibrarySourceStatus, verifyNodesNow } from "./verification.ts";
import { createFeedFetcher } from "./watch-fetch.ts";

/** ONE research store per process (the cycle's busy guard and the inbox in-flight guard key on its objects); a dev reload reuses the first. */
const storeHolder = globalThis as unknown as { __lhResearchStore?: typeof extStores.researchStore };
const researchStore = (storeHolder.__lhResearchStore ??= extStores.researchStore);

export const CYCLE_REFUSALS = {
	"not-configured": "no research model is configured",
	"already-running": "a research cycle is already running",
	"clock-invalid": "the system clock is invalid",
} as const;

export interface MakeResearchGapDeps {
	researcher: {
		run(brief: GapBrief, steers: string[], hooks: GapResearchHooks): Promise<GapFinding & { costUsd: number }>;
	};
	briefFor: (gap: Gap) => GapBrief | Promise<GapBrief>;
	costGate: CostGate;
	control: CycleControl;
	config: ResearchConfig;
}

export function makeResearchGap(deps: MakeResearchGapDeps) {
	return async (
		gap: Gap,
		opts: { steers: string[]; sourceHunt: boolean; ref: string; maxTurns: number },
	): Promise<GapFinding & { costUsd: number }> => {
		if (gap.type !== "no-premises" && gap.type !== "weak-premise" && gap.type !== "contested-no-primary") {
			throw new Error(`cannot research gap of type ${gap.type}`);
		}
		const brief = await deps.briefFor(gap);
		const hooks: GapResearchHooks = {
			signal: deps.control.signal,
			costGate: deps.costGate,
			confidenceThreshold: deps.config.confidenceThreshold,
			maxTurns: opts.maxTurns,
			maxSources: deps.config.maxSourcesPerGap,
			takeSteers: () => deps.control.takeSteers(),
			onAgent: (agent) => deps.control.attach(agent),
		};
		try {
			return await deps.researcher.run(brief, opts.steers, hooks);
		} finally {
			deps.control.attach(null);
		}
	};
}

export interface MakeClassifyDeps {
	classifier: {
		classify(item: FeedItem, candidates: readonly GraphNodeLite[], hooks: WatchClassifyHooks): Promise<WatchClassifyResult>;
	};
	costGate: CostGate;
	control: CycleControl;
}

export function makeClassify(deps: MakeClassifyDeps) {
	return async (
		item: FeedItem,
		candidates: readonly GraphNodeLite[],
		_ref: string,
	): Promise<WatchClassification & { costUsd?: number }> => {
		return deps.classifier.classify(item, candidates, {
			costGate: deps.costGate,
			signal: deps.control.signal,
		});
	};
}

export interface MakeIngestDeps {
	registerImport(filePath: string): void;
	importNotes(input: { filePath: string; text: string }): Promise<{ nodes: number }>;
	emitChanged(): void;
}

/** REQ-rs-07, REQ-res-03: the source's text enters the graph only through the notes-source path, under its deterministic research file. */
export function makeIngest(deps: MakeIngestDeps) {
	return async (source: IngestSource): Promise<number> => {
		const filePath = sourceFilePath(source.locator);
		try {
			deps.registerImport(filePath);
			const stats = await deps.importNotes({ filePath, text: source.text });
			return stats.nodes;
		} finally {
			deps.emitChanged();
		}
	};
}

/** chat-handler imports this layer (for the research agent), so the pipeline is loaded lazily here (no static cycle). */
async function liveIngest(source: IngestSource): Promise<number> {
	const [{ extraction }, { sourceDirectory }] = await Promise.all([import("../chat-handler.ts"), import("../source-organization.ts")]);
	return makeIngest({
		registerImport: (p) => sourceDirectory.registerImport(p),
		importNotes: (input) => extraction.importNotes(input),
		emitChanged: () => emit("sources-changed", {}),
	})(source);
}

async function liveExtractChat(chatId: string): Promise<number> {
	const { extraction } = await import("../chat-handler.ts");
	return (await extraction.runExtraction(chatId)).nodes;
}

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function canRun(): boolean {
	try {
		const settings = stores.settingsStore.readSettings();
		const spec = resolveRoleSpec("researcher", settings);
		if (!spec) return false;
		return providerKeyPresent(spec.provider);
	} catch {
		return false;
	}
}

function researcherEngine(): PiEngine {
	const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
	if (!spec) throw new ModelsNotConfiguredError([ROLE_SLOT.researcher]);
	if (!providerKeyPresent(spec.provider)) {
		throw new ProviderKeyMissingError(spec.provider, [ROLE_SLOT.researcher]);
	}
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.[ROLE_SLOT.researcher]?.cacheRetention);
}

function activateLibraryEntry(entry: LibraryEntryInput): void {
	const entries = extStores.sourcesStore.read();
	const existing = entries.find((e) => e.locator === entry.locator && e.kind === entry.kind);
	if (existing) {
		setLibrarySourceStatus(existing.id, "active", entry.tier);
	} else {
		const added = addLibrarySource({
			kind: entry.kind,
			locator: entry.locator,
			tier: entry.tier,
			label: entry.label,
		});
		setLibrarySourceStatus(added.id, "active", entry.tier);
	}
}

function briefForGap(gap: Gap): GapBrief {
	const g = getGraph(stores.graphStore);
	const node = g.nodes.find((n) => n.id === gap.nodeId);
	const nodeMap = new Map(g.nodes.map((n) => [n.id, n]));
	const premises: string[] = [];
	for (const chain of g.chains) {
		if (chain.conclusion === gap.nodeId) {
			for (const p of chain.premises) {
				const premiseNode = nodeMap.get(p);
				if (premiseNode) premises.push(premiseNode.statement);
			}
		}
	}
	const activeLocators = extStores.sourcesStore.read().filter((e) => e.status === "active").map((e) => e.locator);
	return {
		type: gap.type as GapBrief["type"],
		label: gap.label,
		statement: node?.statement ?? gap.label,
		premises,
		activeLocators,
	};
}

export const researchAdmin = createResearchAdmin({
	frontier: researchStore.frontier,
	log: researchStore.log,
	radar: researchStore.radar,
	watchlist: researchStore.watchlist,
	inboxService: {
		inbox: researchStore.inbox,
		snapshots: extStores.snapshotReader,
		library: { activate: activateLibraryEntry },
		ingest: liveIngest,
		now: () => new Date(),
	},
	newId,
	now: () => new Date(),
});

const serviceHolder = globalThis as unknown as { __lhResearch?: ReturnType<typeof createResearchService> };
export const researchService = (serviceHolder.__lhResearch ??= createResearchService({
	store: researchStore,
	cycleHours: researchConfigFromEnv(process.env).cycleHours,
	canRun,
	now: () => new Date(),
	onError: (err) => console.error("[research service] cycle error:", err),
	buildCycleDeps: (control: CycleControl) => {
		const config = researchConfigFromEnv(process.env);
		const researcher = createGapResearcher({
			engine: researcherEngine,
			search: searchProvider,
		});
		const classifier = createWatchClassifier({ engine: researcherEngine });
		const feedFetcher = createFeedFetcher();

		return {
			now: () => new Date(),
			newId,
			config,
			costGate: liveCostGate,
			graph: () => {
				const g = getGraph(stores.graphStore);
				return {
					nodes: g.nodes.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
					chains: g.chains.map((c) => ({ premises: c.premises, conclusion: c.conclusion })),
				};
			},
			goals: () => deriveGoals(extStores.goalsStore.readEvents()),
			uncovered: () => {
				const summaries = stores.chatStore.listChats();
				const coverage = stores.graphStore.readCoverage();
				const result: UncoveredChat[] = [];
				for (const s of summaries) {
					if (isPracticeLike(s.kind)) continue;
					const record = stores.chatStore.getChat(s.id);
					if (!record) continue;
					const cov = coverageOf(record.messages, coverage, s.id);
					if (cov.uncoveredCount > 0) {
						result.push({ chatId: s.id, title: s.title, messages: cov.uncoveredCount });
					}
				}
				return result;
			},
			weakNodeIds: () => weakPremiseNodeIds(extStores.reviewStore.readEvents(), new Date().toISOString()),
			frontier: researchStore.frontier,
			inbox: researchStore.inbox,
			radar: researchStore.radar,
			watchlist: researchStore.watchlist,
			verification: {
				trustOf: (nodeIds) => {
					const trustMap = deriveTrustMap(extStores.verificationStore.readEvents());
					const result = new Map<string, TrustInfo>();
					for (const id of nodeIds) {
						const state = trustMap.get(id);
						result.set(id, {
							trust: state?.level ?? "unverified",
							hasPrimarySupport: state ? state.evidence.some((e) => e.stance === "supports" && e.tier === "primary") : false,
						});
					}
					return result;
				},
				verifyNodes: async (nodeIds) => {
					await verifyNodesNow([...nodeIds]);
				},
			},
			library: {
				isActive: (locator) => matchSource(locator, extStores.sourcesStore.read()) !== null,
				activeLocators: () => extStores.sourcesStore.read().filter((e) => e.status === "active").map((e) => e.locator),
				activate: activateLibraryEntry,
			},
			snapshots: researchStore.snapshots,
			extractChat: liveExtractChat,
			ingest: liveIngest,
			researchGap: makeResearchGap({
				researcher,
				briefFor: briefForGap,
				costGate: liveCostGate,
				control,
				config,
			}),
			fetchItems: feedFetcher,
			classify: makeClassify({ classifier, costGate: liveCostGate, control }),
		};
	},
}));

export function researchToolContext(chatId: string): ResearchToolContext {
	return {
		chatId,
		chatStore: stores.chatStore,
		listMarks: (limit?: number) => researchAdmin.listMarks(limit),
		setMark: (input) => researchAdmin.agent.setMark(input),
		clearMark: (markId: string) => researchAdmin.agent.clearMark(markId),
		runCycle: () => {
			const res = researchService.start("manual");
			return res.started ? { started: true } : { started: false, reason: CYCLE_REFUSALS[res.reason] };
		},
		status: () => {
			const s = researchService.status();
			return { running: s.running, steers: s.steers };
		},
		steer: (message: string) => researchService.steer(message),
		abort: () => researchService.abort(),
		listInbox: (status?: InboxItem["status"], limit?: number) => researchAdmin.listInbox(status, limit),
		decideInbox: (locator: string, decision: "approved" | "rejected") => researchAdmin.agent.decideInbox(locator, decision),
		listWatchlist: (limit?: number) => researchAdmin.listWatchlist(limit),
		addWatch: (input) => researchAdmin.addWatch(input),
		removeWatch: (id: string) => researchAdmin.removeWatch(id),
		readLog: (limit = 10) => researchAdmin.readLog(limit),
	};
}

export function startResearchSession(): { chatId: string } {
	const chat = stores.chatStore.createChat("Research", "research");
	return { chatId: chat.id };
}

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

export function startResearchScheduler(): void {
	if (schedulerRunning) return;
	schedulerRunning = true;
	if (process.env.NODE_ENV === "test") return;
	schedulerTimer = setInterval(() => {
		try {
			researchService.tick();
		} catch (err) {
			console.error("[research scheduler] tick failed:", err);
		}
	}, 60_000);
	schedulerTimer.unref?.();
}
