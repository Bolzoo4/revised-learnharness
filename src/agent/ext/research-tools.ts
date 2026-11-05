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
 * because they tell the model what to fix.
 *
 * Text the model receives from here is data: log entries, inbox and watchlist
 * entries carry feed and source titles from outside. Results are JSON (so a
 * newline in a title cannot start a new section) and bounded in length.
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
/** A tool result the model reads is cut here; JSON output keeps it one structure. */
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
	markId: Type.Optional(Type.String({ description: "clear: the mark id from list_marks" })),
	scopeKind: Type.Optional(Type.Union([Type.Literal("node"), Type.Literal("subtree"), Type.Literal("goal")], { description: "set: what the mark covers" })),
	scopeId: Type.Optional(Type.String({ description: "set: the node id or goal id" })),
	mark: Type.Optional(Type.Union([Type.Literal("expand"), Type.Literal("hold"), Type.Literal("stop")], { description: "set: expand = go deeper here, hold = verify only, stop = leave alone" })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "set: how many steps beyond the scope the loop may go" })),
	budgetUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "set: spending limit for this region" })),
	note: Type.Optional(Type.String()),
});

const controlInput = Type.Object({
	action: Type.Union([Type.Literal("steer"), Type.Literal("abort")]),
	message: Type.Optional(Type.String({ maxLength: MAX_STEER_CHARS, description: "steer: what the research agent should do differently from now on" })),
});

const listInboxInput = Type.Object({
	status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("activated")])),
});

const decideInput = Type.Object({
	locator: Type.String({ minLength: 1, maxLength: MAX_LOCATOR_CHARS, description: "The source locator exactly as list_inbox shows it" }),
	decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")], { description: "approved = read this one source into the graph; rejected = never propose it again" }),
});

const editWatchInput = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
	id: Type.Optional(Type.String({ description: "remove: the entry id from list_watchlist" })),
	kind: Type.Optional(Type.Union([Type.Literal("arxiv-query"), Type.Literal("feed"), Type.Literal("repo")])),
	query: Type.Optional(Type.String({ maxLength: MAX_LOCATOR_CHARS, description: "add: an arXiv search query, a feed URL, or owner/name" })),
	cadenceHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	goalId: Type.Optional(Type.String()),
});

const logInput = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) });

/** A tool result the model reads: JSON or text, cut to MAX_TOOL_RESULT_CHARS. */
function bounded(value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? "null";
	if (text.length <= MAX_TOOL_RESULT_CHARS) return toToolResult(value);
	return toToolResult(text.slice(0, MAX_TOOL_RESULT_CHARS - TRUNCATED_MARK.length) + TRUNCATED_MARK);
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

export function researchTools(ctx: ResearchToolContext): Record<string, AgentTool<any>> {
	const tools = {
		read_log: {
			name: "read_log",
			label: "read_log",
			description: "The latest research cycles (newest first): gaps chosen, questions, confidence with rationale, sources and what happened to each, nodes added, cost. Also says whether a cycle is running now.",
			parameters: logInput,
			execute: guarded("read_log", (input: { limit?: number }) => ({ running: ctx.status().running, cycles: ctx.readLog(input.limit ?? 5) })),
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
			description: "Set or clear a frontier mark. Marks you set are the learner's: set one only when the learner asked for it.",
			parameters: editMarkInput,
			execute: guarded("edit_mark", (input: Static<typeof editMarkInput>) => {
				if (input.action === "clear") {
					if (!input.markId) return "edit_mark failed: clear needs markId";
					ctx.clearMark(input.markId);
					return `Cleared ${input.markId}.`;
				}
				if (!input.scopeKind || !input.scopeId || !input.mark) return "edit_mark failed: set needs scopeKind, scopeId and mark";
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
			description: "Approve (read this one source into the graph) or reject (never propose it again) a pending source, ONLY after the learner told you which. Adding a source to the library is done by the learner on the research page.",
			parameters: decideInput,
			execute: guarded("decide_inbox", async (input: Static<typeof decideInput>) => {
				// The inbox keys locators in normalized form; the model's copy may differ cosmetically.
				const locator = normalizeLocator(input.locator);
				if (locator === "") return "decide_inbox failed: the locator is empty";
				if (locator.length > MAX_LOCATOR_CHARS) return "decide_inbox failed: the locator is too long";
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
			description: "Add or remove a watch entry (kind arxiv-query | feed | repo).",
			parameters: editWatchInput,
			execute: guarded("edit_watchlist", (input: Static<typeof editWatchInput>) => {
				if (input.action === "remove") {
					if (!input.id) return "edit_watchlist failed: remove needs id";
					ctx.removeWatch(input.id);
					return `Removed ${input.id}.`;
				}
				if (!input.kind || !input.query) return "edit_watchlist failed: add needs kind and query";
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
