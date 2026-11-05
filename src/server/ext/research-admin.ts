// src/server/ext/research-admin.ts
/**
 * The levers over the research loop (REQ-rs-03, REQ-rs-08, REQ-rs-11, REQ-rs-15):
 * marks, the inbox, the watchlist and the log reads.
 *
 * Two callers, two authors. The learner's functions write as author "user".
 * The agent's tool context uses `agent.*`, which writes as author "agent" and
 * refuses to change a learner's mark or to activate a source. Both paths share
 * one validator and one writer, so the author is decided by the path, not by
 * the input.
 *
 * Inbox approval and activation go only through decideInboxItem, and only for
 * a locator that is a PENDING inbox item after normalizeLocator. The cycle never
 * activates a source, and nothing here does either except that decision.
 * Every input is validated before the first append. Expected mistakes raise
 * ResearchInputError with a fixed phrase; internal failures are rethrown and
 * the route answers them generically.
 */

import {
	MAX_ID_CHARS,
	MAX_LOCATOR_CHARS,
	MAX_MARK_BUDGET_USD,
	MAX_MARK_DEPTH,
	MAX_NOTE_CHARS,
	MAX_READ_LOG_LIMIT,
	MAX_WATCH_CADENCE_HOURS,
	MIN_WATCH_CADENCE_HOURS,
} from "../../agent/ext/research-tools.ts";
import { deriveMarks, parseFrontierEvent, type FrontierEvent, type Mark, type MarkAuthor, type MarkKind, type MarkScope } from "../../core/ext/frontier.ts";
import { decideInboxItem, InboxError, type InboxDecisionResult, type InboxServiceDeps } from "../../core/ext/inbox-service.ts";
import { deriveInbox, normalizeLocator, type InboxDecision, type InboxItem, type InboxStatus } from "../../core/ext/inbox.ts";
import type { CycleLogEntry } from "../../core/ext/research-log.ts";
import type { EventLog } from "../../core/ext/research-ports.ts";
import type { SourceTier } from "../../core/ext/sources.ts";
import { DEFAULT_WATCH_CADENCE_HOURS, parseWatchEntry, validateWatchTarget, type RadarEvent, type WatchEntry, type WatchKind } from "../../core/ext/watch.ts";
import { ResearchInputError } from "./research-errors.ts";

export interface ResearchAdminDeps {
	frontier: EventLog<FrontierEvent>;
	log: EventLog<CycleLogEntry>;
	radar: EventLog<RadarEvent>;
	watchlist: { read(): WatchEntry[]; write(entries: readonly WatchEntry[]): void };
	/** Its `inbox` is the store's inbox ledger, the same object the cycle appends to. */
	inboxService: InboxServiceDeps;
	newId(prefix: string): string;
	now(): Date;
}

export interface SetMarkInput {
	scope: MarkScope;
	mark: MarkKind;
	maxDepth?: number;
	budgetUsd?: number;
	note?: string;
}

export interface AddWatchInput {
	kind: WatchKind;
	query: string;
	cadenceHours?: number;
	goalId?: string;
}

const MARK_KINDS = new Set<string>(["expand", "hold", "stop"]);
const SCOPE_KINDS = new Set<string>(["node", "subtree", "goal"]);
const INBOX_STATUSES = new Set<string>(["pending", "approved", "rejected", "activated"]);
const INBOX_DECISIONS = new Set<string>(["approved", "rejected", "activated"]);
const AGENT_DECISIONS = new Set<string>(["approved", "rejected"]);
const TIERS = new Set<string>(["primary", "secondary"]);
const WATCH_KINDS = new Set<string>(["arxiv-query", "feed", "repo"]);

/** The fixed phrase for each refusal of the inbox service. Its own messages (which name the locator) never leave the admin. */
const INBOX_MESSAGES: Record<InboxError["code"], string> = {
	"not-found": "no pending inbox source at that locator",
	"not-pending": "no pending inbox source at that locator",
	"in-progress": "that source is already being decided",
	"snapshot-missing": "the stored text of that source is gone",
	"bad-decision": "a decision must be approved, rejected or activated",
	"bad-tier": "a tier must be primary or secondary",
};

const isId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_ID_CHARS;
const bad = (message: string): ResearchInputError => new ResearchInputError(message);

/** The newest `limit` items, in their order. The default and the maximum are MAX_READ_LOG_LIMIT, as for the log. */
function bounded<T>(items: T[], limit: number | undefined): T[] {
	const n = limit ?? MAX_READ_LOG_LIMIT;
	if (!Number.isInteger(n) || n < 1 || n > MAX_READ_LOG_LIMIT) throw bad(`limit must be from 1 to ${MAX_READ_LOG_LIMIT}`);
	return items.slice(-n);
}

export function createResearchAdmin(deps: ResearchAdminDeps) {
	/** An ISO time from the clock; a clock that gives no valid instant is an internal failure, not an input mistake. */
	function stamp(): string {
		const d = deps.now();
		if (!Number.isFinite(d.getTime())) throw new Error("the admin clock is not valid");
		return d.toISOString();
	}

	/** The one writer of marks. The author is the caller path's, never the input's. */
	function writeMark(input: SetMarkInput, author: MarkAuthor): Mark {
		const scope = input.scope as Partial<MarkScope> | undefined;
		if (typeof scope !== "object" || scope === null || typeof scope.kind !== "string" || !SCOPE_KINDS.has(scope.kind) || !isId(scope.id)) {
			throw bad("a mark needs a scope kind (node, subtree or goal) and a scope id");
		}
		if (typeof input.mark !== "string" || !MARK_KINDS.has(input.mark)) throw bad("a mark must be expand, hold or stop");
		if (input.maxDepth !== undefined && !(Number.isInteger(input.maxDepth) && input.maxDepth >= 0 && input.maxDepth <= MAX_MARK_DEPTH)) {
			throw bad(`maxDepth must be a whole number from 0 to ${MAX_MARK_DEPTH}`);
		}
		if (input.budgetUsd !== undefined && !(Number.isFinite(input.budgetUsd) && input.budgetUsd > 0 && input.budgetUsd <= MAX_MARK_BUDGET_USD)) {
			throw bad(`budgetUsd must be above 0 and at most ${MAX_MARK_BUDGET_USD}`);
		}
		if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > MAX_NOTE_CHARS)) {
			throw bad(`note must be at most ${MAX_NOTE_CHARS} characters`);
		}
		const event: FrontierEvent = {
			type: "set",
			markId: deps.newId("mark"),
			scope: { kind: scope.kind as MarkScope["kind"], id: scope.id },
			mark: input.mark,
			...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
			...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
			note: input.note ?? "",
			author,
			at: stamp(),
		};
		if (parseFrontierEvent(event) === null) throw bad("the mark is not valid");
		deps.frontier.append(event);
		return deriveMarks([event])[0]!;
	}

	/** The one clearer of marks. An agent may not clear a learner's mark. */
	function clearWithAuthor(markId: unknown, author: MarkAuthor): void {
		if (!isId(markId)) throw bad(`a mark id is 1 to ${MAX_ID_CHARS} characters`);
		const target = deriveMarks(deps.frontier.readAll()).find((m) => m.id === markId);
		if (target === undefined) throw bad("no such mark");
		if (author === "agent" && target.author === "user") throw bad("the learner's marks are changed by the learner only");
		deps.frontier.append({ type: "clear", markId, author, at: stamp() });
	}

	/** The one decider of inbox items: pending check first, then decideInboxItem (the only path that activates or ingests). */
	async function decide(rawLocator: unknown, decision: unknown, tier: unknown): Promise<InboxDecisionResult> {
		if (typeof rawLocator !== "string" || rawLocator.length > MAX_LOCATOR_CHARS) throw bad(`a locator is at most ${MAX_LOCATOR_CHARS} characters`);
		const locator = normalizeLocator(rawLocator);
		if (locator === "") throw bad("a locator is required");
		if (typeof decision !== "string" || !INBOX_DECISIONS.has(decision)) throw bad("a decision must be approved, rejected or activated");
		if (typeof tier !== "string" || !TIERS.has(tier)) throw bad("a tier must be primary or secondary");
		const item = deriveInbox(deps.inboxService.inbox.readAll()).find((i) => i.locator === locator);
		if (item === undefined || item.status !== "pending") throw bad("no pending inbox source at that locator");
		try {
			return await decideInboxItem(deps.inboxService, locator, decision as InboxDecision, tier as SourceTier);
		} catch (e) {
			if (e instanceof InboxError) throw bad(INBOX_MESSAGES[e.code]);
			throw e;
		}
	}

	return {
		listMarks: (limit?: number): Mark[] => bounded(deriveMarks(deps.frontier.readAll()), limit),

		/** The learner's marks: author "user". */
		setMark: (input: SetMarkInput): Mark => writeMark(input, "user"),
		clearMark: (markId: string): void => clearWithAuthor(markId, "user"),

		/** The agent tool context's writes: author "agent", same validation, cannot touch a learner's mark or activate a source. */
		agent: Object.freeze({
			setMark: (input: SetMarkInput): Mark => writeMark(input, "agent"),
			clearMark: (markId: string): void => clearWithAuthor(markId, "agent"),
			decideInbox: async (locator: string, decision: "approved" | "rejected"): Promise<InboxDecisionResult> => {
				if (typeof decision !== "string" || !AGENT_DECISIONS.has(decision)) throw bad("the agent may only approve or reject a source");
				return decide(locator, decision, "secondary");
			},
		}),

		listInbox(status?: InboxStatus, limit?: number): InboxItem[] {
			if (status !== undefined && !INBOX_STATUSES.has(status)) throw bad("a status must be pending, approved, rejected or activated");
			return bounded(
				deriveInbox(deps.inboxService.inbox.readAll()).filter((i) => status === undefined || i.status === status),
				limit,
			);
		},

		/** The learner's decision on a pending source. "activated" also adds the library entry (the only activation path). */
		decideInbox: (locator: string, decision: InboxDecision, tier: SourceTier = "secondary"): Promise<InboxDecisionResult> => decide(locator, decision, tier),

		listWatchlist: (limit?: number): WatchEntry[] => bounded(deps.watchlist.read(), limit),

		addWatch(input: AddWatchInput): WatchEntry {
			if (typeof input.kind !== "string" || !WATCH_KINDS.has(input.kind)) throw bad("a watch entry is an arxiv-query, a feed or a repo");
			const query = typeof input.query === "string" ? input.query.trim() : "";
			if (query === "" || query.length > MAX_LOCATOR_CHARS) throw bad(`a watch query is 1 to ${MAX_LOCATOR_CHARS} characters`);
			const cadence = input.cadenceHours ?? DEFAULT_WATCH_CADENCE_HOURS;
			if (!(Number.isFinite(cadence) && cadence >= MIN_WATCH_CADENCE_HOURS && cadence <= MAX_WATCH_CADENCE_HOURS)) {
				throw bad(`cadenceHours must be from ${MIN_WATCH_CADENCE_HOURS} to ${MAX_WATCH_CADENCE_HOURS}`);
			}
			if (input.goalId !== undefined && !isId(input.goalId)) throw bad(`goalId must be 1 to ${MAX_ID_CHARS} characters`);
			const problem = validateWatchTarget({ kind: input.kind, query });
			if (problem !== null) throw bad(problem);
			const entry = parseWatchEntry({
				id: deps.newId("watch"),
				kind: input.kind,
				query,
				cadenceHours: cadence,
				...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
			});
			if (entry === null) throw bad("the watch entry is not valid");
			deps.watchlist.write([...deps.watchlist.read(), entry]);
			return entry;
		},

		removeWatch(id: string): void {
			if (!isId(id)) throw bad(`a watch id is 1 to ${MAX_ID_CHARS} characters`);
			const entries = deps.watchlist.read();
			if (!entries.some((e) => e.id === id)) throw bad("no such watch entry");
			deps.watchlist.write(entries.filter((e) => e.id !== id));
		},

		/** Newest first. */
		readLog(limit = 10): CycleLogEntry[] {
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LOG_LIMIT) throw bad(`limit must be from 1 to ${MAX_READ_LOG_LIMIT}`);
			return deps.log.readAll().slice(-limit).reverse();
		},

		/** Newest first, classified items only. */
		listRadar(limit = 20): Extract<RadarEvent, { type: "classified" }>[] {
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LOG_LIMIT) throw bad(`limit must be from 1 to ${MAX_READ_LOG_LIMIT}`);
			return deps.radar
				.readAll()
				.filter((e): e is Extract<RadarEvent, { type: "classified" }> => e.type === "classified")
				.slice(-limit)
				.reverse();
		},
	};
}

export type ResearchAdmin = ReturnType<typeof createResearchAdmin>;
