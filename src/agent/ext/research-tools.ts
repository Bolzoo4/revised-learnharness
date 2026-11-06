// src/agent/ext/research-tools.ts
/**
 * THE RESEARCH SESSION'S TOOLS (REQ-rs-15, REQ-rs-16): marks, run/steer/stop a
 * cycle, the inbox, the watchlist, the log. Each is a thin call into the
 * context (the server's research admin and service). The agent can approve or
 * reject an inbox source when the learner says so; ACTIVATING a source (adding
 * it to the library) is the learner's click on the research page, never a tool
 * (REQ-src-02). No tool links nodes: links come only from the extraction pipeline.
 *
 * Tools never throw into the loop: every execute is guarded, and a failure comes
 * back as a generic text result ("<tool> failed.") that carries no internal
 * message. Validation problems in the model's own arguments are reported in text
 * ("<tool> refused: ...") because they tell the model what to fix. The schemas
 * bound every model-controlled field, and each execute re-checks the same bounds,
 * since a direct call does not go through the schema.
 *
 * Text the model receives from here is data: log entries, inbox and watchlist
 * entries carry feed and source titles from outside. Results are bounded in
 * length; a result that is not a string stays valid JSON when it is cut.
 * Steer messages are the learner's words and are bounded before the loop sees them.
 * Watch targets pass validateWatchTarget (a feed must be a public URL), the same
 * egress rule the watch fetch enforces.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Mark } from "../../core/ext/frontier.ts";
import type { InboxItem } from "../../core/ext/inbox.ts";
import { normalizeLocator } from "../../core/ext/inbox.ts";
import type { CycleLogEntry } from "../../core/ext/research-log.ts";
import type { WatchEntry } from "../../core/ext/watch.ts";
import { validateWatchTarget } from "../../core/ext/watch.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { toToolResult } from "../tool-execute.ts";
import { healToolRecord } from "../tools/heal.ts";

/** The learner's steer text, bounded (the research agent's own steer cap is 2000 too). */
export const MAX_STEER_CHARS = 2000;
/** A locator is bounded the same way the fetch capture bounds one (MAX_LOCATOR_CHARS in gap-research). */
export const MAX_LOCATOR_CHARS = 2048;
/** Ids the model names back (mark, scope, goal and watch entry ids) are bounded like a locator's length, far above any real id. */
export const MAX_ID_CHARS = 200;
/** A mark note is read back to the learner, so it is bounded. */
export const MAX_NOTE_CHARS = 2000;
/** How many steps beyond its scope a mark may reach. research-config's defaultMaxDepth is 2; 10 is the most a model may ask for. */
export const MAX_MARK_DEPTH = 10;
/** The largest spending limit one mark may set, in USD. research-config has no maximum; the daily ceiling belongs to the learner. */
export const MAX_MARK_BUDGET_USD = 100;
/** A watch entry is polled at least hourly and at most yearly: a model never sets a sub-hour cadence. */
export const MIN_WATCH_CADENCE_HOURS = 1;
export const MAX_WATCH_CADENCE_HOURS = 24 * 365;
/** read_log returns at most this many cycles. */
export const MAX_READ_LOG_LIMIT = 20;
/** A tool result the model reads is cut to this many characters. */
export const MAX_TOOL_RESULT_CHARS = 20_000;
const TRUNCATED_MARK = "\n[truncated]";

export interface ResearchToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	listMarks(): Mark[];
	setMark(input: { scope: { kind: "node" | "subtree" | "goal"; id: string }; mark: "expand" | "hold" | "stop"; maxDepth?: number; budgetUsd?: number; note?: string }): Mark;
	clearMark(markId: string): void;
	runCycle(): { started: true } | { started: false; reason: string };
	status(): { running: boolean; steers: string[] };
	steer(message: string): "delivered" | "queued" | null;
	abort(): boolean;
	listInbox(status?: InboxItem["status"]): InboxItem[];
	decideInbox(locator: string, decision: "approved" | "rejected"): Promise<{ decision: string; nodesAdded: number }>;
	listWatchlist(): WatchEntry[];
	addWatch(input: { kind: "arxiv-query" | "feed" | "repo"; query: string; cadenceHours?: number; goalId?: string }): WatchEntry;
	removeWatch(id: string): void;
	readLog(limit: number): CycleLogEntry[];
}

const emptyInput = Type.Object({});

const editMarkInput = Type.Object({
	action: Type.Union([Type.Literal("set"), Type.Literal("clear")]),
	markId: Type.Optional(Type.String({ maxLength: MAX_ID_CHARS, description: "clear: the mark id from list_marks" })),
	scopeKind: Type.Optional(Type.Union([Type.Literal("node"), Type.Literal("subtree"), Type.Literal("goal")], { description: "set: what the mark covers" })),
	scopeId: Type.Optional(Type.String({ maxLength: MAX_ID_CHARS, description: "set: the node id or goal id" })),
	mark: Type.Optional(Type.Union([Type.Literal("expand"), Type.Literal("hold"), Type.Literal("stop")], { description: "set: expand = go deeper here, hold = verify only, stop = leave alone" })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_MARK_DEPTH, description: "set: how many steps beyond the scope the loop may go" })),
	budgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_MARK_BUDGET_USD, description: "set: spending limit for this region" })),
	note: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
});

const controlInput = Type.Object({
	action: Type.Union([Type.Literal("steer"), Type.Literal("abort")]),
	message: Type.Optional(Type.String({ maxLength: MAX_STEER_CHARS, description: "steer: what the research agent should do differently from now on" })),
});

const listInboxInput = Type.Object({
	status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("activated")])),
});

const decideInput = Type.Object({
	locator: Type.String({ minLength: 1, maxLength: MAX_LOCATOR_CHARS, description: "The source locator the learner named in this chat, as list_inbox shows it" }),
	decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")], { description: "approved = read this one source into the graph; rejected = never propose it again" }),
});

const editWatchInput = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
	id: Type.Optional(Type.String({ maxLength: MAX_ID_CHARS, description: "remove: the entry id from list_watchlist" })),
	kind: Type.Optional(Type.Union([Type.Literal("arxiv-query"), Type.Literal("feed"), Type.Literal("repo")])),
	query: Type.Optional(Type.String({ maxLength: MAX_LOCATOR_CHARS, description: "add: an arXiv search query, a feed URL, or owner/name" })),
	cadenceHours: Type.Optional(Type.Number({ minimum: MIN_WATCH_CADENCE_HOURS, maximum: MAX_WATCH_CADENCE_HOURS, description: "add: hours between checks, from 1 to 8760" })),
	goalId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_CHARS, description: "add: optional, the goal whose scope this entry is compared against" })),
});

const logInput = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LOG_LIMIT })) });

/** A model argument out of range: the reply names the argument so the model can fix it. */
const refused = (tool: string, problem: string): string => `${tool} refused: ${problem}.`;

/** The longest prefix of `s` of at most `n` UTF-16 units that does not end in a high surrogate (its pair would be cut). */
function cutText(s: string, n: number): string {
	let end = Math.min(n, s.length);
	const last = s.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
	return s.slice(0, end);
}

/** Valid JSON of at most the cap: a wrapper with the flag and the longest preview of `json` that still fits. */
function truncatedJson(json: string): string {
	const wrap = (n: number) => JSON.stringify({ truncated: true, preview: cutText(json, n) });
	let lo = 0;
	let hi = json.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (wrap(mid).length <= MAX_TOOL_RESULT_CHARS) lo = mid;
		else hi = mid - 1;
	}
	return wrap(lo);
}

/** A tool result the model reads: a string is cut and marked; any other value stays JSON, cut to a flagged preview. */
function bounded(value: unknown) {
	if (typeof value === "string") {
		if (value.length <= MAX_TOOL_RESULT_CHARS) return toToolResult(value);
		return toToolResult(cutText(value, MAX_TOOL_RESULT_CHARS - TRUNCATED_MARK.length) + TRUNCATED_MARK);
	}
	const json = JSON.stringify(value) ?? "null";
	if (json.length <= MAX_TOOL_RESULT_CHARS) return toToolResult(value);
	return toToolResult(truncatedJson(json));
}

/** The generic failure: the model learns that the tool failed, never why (internal messages stay out). */
const failed = (tool: string) => toToolResult(`${tool} failed.`);

/** Every execute runs through this: a throw from the context becomes the generic failure text; any other value is bounded. */
function guarded<I>(name: string, run: (input: I) => unknown): (id: string, input: I) => Promise<ReturnType<typeof toToolResult>> {
	return async (_id, input) => {
		try {
			return bounded(await run(input));
		} catch {
			return failed(name);
		}
	};
}

/** The refusal of a decide_inbox whose locator the learner did not name (a fixed phrase, the model's own mistake). */
export const NOT_NAMED_REFUSAL = "the learner has not named this source";

/** Whether one learner message (role user) names the locator: a whitespace token that normalizes to it, or the whole message does. */
function learnerNames(messages: readonly LhMessage[], locator: string): boolean {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const raw = typeof m.content === "string" ? m.content : (m.content as Array<{ type?: string; text?: string }>).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join(" ");
		if (normalizeLocator(raw) === locator) return true;
		for (const token of raw.split(/\s+/)) {
			const bare = token.replace(/[)\]>,.;:'"]+$/, "");
			if (bare !== "" && normalizeLocator(bare) === locator) return true;
		}
	}
	return false;
}

/** The first problem with a set-mark argument, or null. */
function markProblem(input: Static<typeof editMarkInput>): string | null {
	if (input.scopeId !== undefined && input.scopeId.length > MAX_ID_CHARS) return `scopeId must be at most ${MAX_ID_CHARS} characters`;
	if (input.maxDepth !== undefined && !(Number.isInteger(input.maxDepth) && input.maxDepth >= 0 && input.maxDepth <= MAX_MARK_DEPTH)) return `maxDepth must be a whole number from 0 to ${MAX_MARK_DEPTH}`;
	if (input.budgetUsd !== undefined && !(Number.isFinite(input.budgetUsd) && input.budgetUsd > 0 && input.budgetUsd <= MAX_MARK_BUDGET_USD)) return `budgetUsd must be above 0 and at most ${MAX_MARK_BUDGET_USD}`;
	if (input.note !== undefined && input.note.length > MAX_NOTE_CHARS) return `note must be at most ${MAX_NOTE_CHARS} characters`;
	return null;
}

/** The first problem with an add-watch argument, or null. */
function watchProblem(input: Static<typeof editWatchInput>): string | null {
	if (input.query !== undefined && input.query.length > MAX_LOCATOR_CHARS) return `query must be at most ${MAX_LOCATOR_CHARS} characters`;
	if (input.cadenceHours !== undefined && !(Number.isFinite(input.cadenceHours) && input.cadenceHours >= MIN_WATCH_CADENCE_HOURS && input.cadenceHours <= MAX_WATCH_CADENCE_HOURS)) return `cadenceHours must be from ${MIN_WATCH_CADENCE_HOURS} to ${MAX_WATCH_CADENCE_HOURS}`;
	if (input.goalId !== undefined && (input.goalId === "" || input.goalId.length > MAX_ID_CHARS)) return `goalId must be 1 to ${MAX_ID_CHARS} characters`;
	return null;
}

export function researchTools(ctx: ResearchToolContext): Record<string, AgentTool<any>> {
	const tools = {
		read_log: {
			name: "read_log",
			label: "read_log",
			description: "The latest research cycles (newest first): gaps chosen, questions, confidence with rationale, sources and what happened to each, nodes added, cost. Also says whether a cycle is running now.",
			parameters: logInput,
			execute: guarded("read_log", (input: { limit?: number }) => {
				if (input.limit !== undefined && !(input.limit >= 1 && input.limit <= MAX_READ_LOG_LIMIT)) return refused("read_log", `limit must be from 1 to ${MAX_READ_LOG_LIMIT}`);
				return { running: ctx.status().running, cycles: ctx.readLog(input.limit ?? 5) };
			}),
		} satisfies AgentTool<typeof logInput>,

		list_marks: {
			name: "list_marks",
			label: "list_marks",
			description: "The frontier marks now in force (user and agent authored).",
			parameters: emptyInput,
			execute: guarded("list_marks", () => ctx.listMarks()),
		} satisfies AgentTool<typeof emptyInput>,

		edit_mark: {
			name: "edit_mark",
			label: "edit_mark",
			description: "Set or clear a frontier mark. Set one only when the learner asked for it; clear only a mark the learner asked to clear.",
			parameters: editMarkInput,
			execute: guarded("edit_mark", (input: Static<typeof editMarkInput>) => {
				if (input.action === "clear") {
					if (!input.markId) return "edit_mark failed: clear needs markId";
					if (input.markId.length > MAX_ID_CHARS) return refused("edit_mark", `markId must be at most ${MAX_ID_CHARS} characters`);
					ctx.clearMark(input.markId);
					return `Cleared ${input.markId}.`;
				}
				if (!input.scopeKind || !input.scopeId || !input.mark) return "edit_mark failed: set needs scopeKind, scopeId and mark";
				const problem = markProblem(input);
				if (problem !== null) return refused("edit_mark", problem);
				return ctx.setMark({
						scope: { kind: input.scopeKind, id: input.scopeId },
						mark: input.mark,
						...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
						...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
						...(input.note !== undefined ? { note: input.note } : {}),
					});
			}),
		} satisfies AgentTool<typeof editMarkInput>,

		run_cycle: {
			name: "run_cycle",
			label: "run_cycle",
			description: "Start a research cycle now, in the background. Refused when one is already running or no model is configured.",
			parameters: emptyInput,
			execute: guarded("run_cycle", () => ctx.runCycle()),
		} satisfies AgentTool<typeof emptyInput>,

		control_cycle: {
			name: "control_cycle",
			label: "control_cycle",
			description: "Steer the running cycle (the message reaches the research agent at its next step) or abort it before its next gap.",
			parameters: controlInput,
			execute: guarded("control_cycle", (input: Static<typeof controlInput>) => {
				if (input.action === "abort") return ctx.abort() ? "Abort requested." : "No cycle is running.";
				const message = input.message?.trim().slice(0, MAX_STEER_CHARS) ?? "";
				if (!message) return "control_cycle failed: steer needs a message";
				const r = ctx.steer(message);
				return r === null ? "No cycle is running." : r === "delivered" ? "Delivered to the research agent." : "Queued for the next gap.";
			}),
		} satisfies AgentTool<typeof controlInput>,

		list_inbox: {
			name: "list_inbox",
			label: "list_inbox",
			description: "Sources the loop found that are not in an active library entry. Default: the pending ones.",
			parameters: listInboxInput,
			execute: guarded("list_inbox", (input: Static<typeof listInboxInput>) => ctx.listInbox(input.status ?? "pending")),
		} satisfies AgentTool<typeof listInboxInput>,

		decide_inbox: {
			name: "decide_inbox",
			label: "decide_inbox",
			description: "Approve (read this one source into the graph) or reject (never propose it again) a pending source, ONLY for a source the learner named in this chat. Pass the locator the learner named, as list_inbox shows it; never a title you picked from the inbox. Adding a source to the library is done by the learner on the research page.",
			parameters: decideInput,
			execute: guarded("decide_inbox", async (input: Static<typeof decideInput>) => {
				// The inbox keys locators in normalized form; the model's copy may differ cosmetically.
				const locator = normalizeLocator(input.locator);
				if (locator === "") return "decide_inbox failed: the locator is empty";
				if (locator.length > MAX_LOCATOR_CHARS) return "decide_inbox failed: the locator is too long";
				// Only a source the LEARNER named (in a user message of this chat) may be decided; an assistant or tool mention is not enough.
				const record = ctx.chatStore.getChat(ctx.chatId);
				if (!record || !learnerNames(record.messages, locator)) return refused("decide_inbox", NOT_NAMED_REFUSAL);
				return await ctx.decideInbox(locator, input.decision);
			}),
		} satisfies AgentTool<typeof decideInput>,

		list_watchlist: {
			name: "list_watchlist",
			label: "list_watchlist",
			description: "The watched arXiv queries, feeds and repositories.",
			parameters: emptyInput,
			execute: guarded("list_watchlist", () => ctx.listWatchlist()),
		} satisfies AgentTool<typeof emptyInput>,

		edit_watchlist: {
			name: "edit_watchlist",
			label: "edit_watchlist",
			description: "Add or remove a watch entry (kind arxiv-query | feed | repo). Add only when the learner asks for it; remove only the entry the learner names.",
			parameters: editWatchInput,
			execute: guarded("edit_watchlist", (input: Static<typeof editWatchInput>) => {
				if (input.action === "remove") {
					if (!input.id) return "edit_watchlist failed: remove needs id";
					if (input.id.length > MAX_ID_CHARS) return refused("edit_watchlist", `id must be at most ${MAX_ID_CHARS} characters`);
					ctx.removeWatch(input.id);
					return `Removed ${input.id}.`;
				}
				if (!input.kind || !input.query) return "edit_watchlist failed: add needs kind and query";
				const bound = watchProblem(input);
				if (bound !== null) return refused("edit_watchlist", bound);
				const problem = validateWatchTarget({ kind: input.kind, query: input.query });
				if (problem !== null) return `edit_watchlist failed: ${problem}`;
				return ctx.addWatch({
						kind: input.kind,
						query: input.query,
						...(input.cadenceHours !== undefined ? { cadenceHours: input.cadenceHours } : {}),
						...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
					});
			}),
		} satisfies AgentTool<typeof editWatchInput>,
	};
	return healToolRecord(tools as Record<string, AgentTool<any>>);
}
