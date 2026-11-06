// src/server/ext/debrief-live.ts
/**
 * @node ext/debrief/live
 * Live wiring of the debrief service: the real ledgers and chat store, the
 * strong-slot model (read fresh per call, like the node-knowledge writer),
 * upstream's call pricing and the shared daily cost gate. Nothing here has
 * logic worth a unit test; the factories it calls are tested.
 */

import { createDebriefWriter } from "../../agent/ext/debrief-writer.ts";
import { piEngineForSpec } from "../../agent/models.ts";
import { readDebriefConfig } from "../../core/ext/debrief/config.ts";
import { WriterUnavailableError, type DebriefWriter } from "../../core/ext/debrief/ports.ts";
import { getGraph } from "../../core/graph.ts";
import { DEFAULT_PLAN_PARAMS } from "../../core/ext/daily-plan.ts";
import { deriveDocuments } from "../../core/ext/study/documents.ts";
import { deriveReading } from "../../core/ext/study/reading.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { providerKeyPresent } from "../keys.ts";
import { callCost } from "../pricing.ts";
import { stores } from "../stores.ts";
import { liveCostGate } from "./cost-live.ts";
import { createDebriefService, newDebriefState, type DebriefState } from "./debrief-service.ts";
import { createDebriefSources } from "./debrief-sources.ts";
import { createStudyFeed } from "./debrief-study.ts";
import { extStores } from "./stores.ts";
import { trustViews } from "./verification.ts";

const config = readDebriefConfig(process.env, DEFAULT_PLAN_PARAMS.budgetSec);

/** Survives dev-server module reloads: one in-flight table per process. */
const g = globalThis as { __lhExtDebriefState?: DebriefState; __lhExtDebriefTimer?: ReturnType<typeof setInterval> };
const state = (g.__lhExtDebriefState ??= newDebriefState());

const writer: DebriefWriter = {
	async write(request) {
		const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
		if (!spec) throw new WriterUnavailableError("no model is configured for the strong slot");
		if (!providerKeyPresent(spec.provider)) throw new WriterUnavailableError(`no API key for provider ${spec.provider}`);
		return createDebriefWriter({ engine: piEngineForSpec(spec, true), priceCall: callCost }).write(request);
	},
};

const liveNow = (): Date => {
	let max = Date.now();
	for (const s of sources.sessions()) {
		const t = Date.parse(s.lastActivityAt);
		if (t > max) max = t;
	}
	return new Date(max);
};

const sources = createDebriefSources({
	chats: {
		list: () => stores.chatStore.listChats(),
		messages: (id) => stores.chatStore.getChat(id)?.messages ?? [],
	},
	reviewEvents: () => extStores.reviewStore.readEvents(),
	officeHoursEvents: () => extStores.officeHoursLedger.readAll(),
	exerciseEvents: () => extStores.exercisesLedger.readAll(),
	cardEvents: () => extStores.cardsStore.readEvents(),
	goalEvents: () => extStores.goalsStore.readEvents(),
	activityEvents: () => extStores.activityLedger.readAll(),
	journal: () => extStores.journalLedger.readAll(),
	graph: () => getGraph(stores.graphStore),
	lecture: (id) => extStores.lecturesStore.get(id),
	trustLevels: (ids) => new Map(trustViews([...ids]).map((v) => [v.nodeId, v.level] as const)),
	study: createStudyFeed({
		documents: () => deriveDocuments(extStores.documentsLedger.readAll()),
		reading: () => extStores.readingLedger.readAll(),
		links: () => extStores.studyLinksLedger.readAll(),
		readPages: (events, documentId) => deriveReading(events, documentId).readPages,
	}),
	now: liveNow,
	idleMs: config.idleMs,
	budgetSec: config.budgetSec,
});

export const debriefService = createDebriefService({
	journal: extStores.journalLedger,
	activity: extStores.activityLedger,
	sources,
	writer,
	gate: liveCostGate,
	config,
	lecture: (id) => extStores.lecturesStore.get(id),
	now: liveNow,
	state,
});

const SWEEP_EVERY_MS = 5 * 60_000;
const FIRST_SWEEP_MS = 20_000;

/** Idempotent; called once from instrumentation.ts at server start. Inert under tests. */
export function startDebriefScheduler(): void {
	if (process.env.NODE_ENV === "test") return;
	if (g.__lhExtDebriefTimer !== undefined) return;
	const tick = () => debriefService.sweep().catch((err) => console.error("[ext] debrief sweep failed:", err));
	setTimeout(tick, FIRST_SWEEP_MS).unref(); // the next opening of the app catches up on what ended while it was closed
	g.__lhExtDebriefTimer = setInterval(tick, SWEEP_EVERY_MS);
	g.__lhExtDebriefTimer.unref();
}
