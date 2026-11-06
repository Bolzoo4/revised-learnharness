// src/server/ext/mcp/catalog.ts
/**
 * The tool catalog: name, title, description and the zod INPUT contract of each
 * tool (REQ-mcp-12). Core has no zod, so the schemas live here. Every schema is
 * strict: an unknown key is an error, which is how a write-shaped request is
 * refused at the protocol edge (runTool refuses it again in the core).
 * The language-neutral contract (docs/ext/CONTRACTS.md) is derived from these.
 */

import { z } from "zod";
import { LIMITS } from "../../../core/ext/mcp/limits.ts";

const id = z.string().min(1).max(LIMITS.idMaxChars);
const limit = z.number().int().min(1).max(LIMITS.listMax).optional();

/** The session kinds of the journal plus "weekly" (a test pins this list to SESSION_KINDS). */
export const DEBRIEF_KINDS = ["review", "lecture", "office_hours", "study", "exercises", "weekly"] as const;

const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

export interface ToolSpec {
	title: string;
	description: string;
	input: z.ZodObject<z.ZodRawShape>;
}

export const CATALOG: Record<string, ToolSpec> = {
	search_nodes: {
		title: "Search knowledge nodes",
		description:
			"Fuzzy text search over node names, statements and aliases. Returns id, name, a shortened statement and the trust level. Read-only.",
		input: strict({
			query: z.string().min(1).max(LIMITS.queryMaxChars),
			limit,
			trust: z.enum(["unverified", "sourced", "contested", "refuted"]).optional(),
			goalId: id.optional(),
		}),
	},
	get_node: {
		title: "Read one knowledge node",
		description:
			"Statement, aliases, trust level with evidence, the current explanation (flagged stale or without source context), premises, conclusions, alternative arguments, citing lectures, card count, review state and goals. Read-only.",
		input: strict({ id }),
	},
	get_neighbors: {
		title: "Read a node's neighbourhood",
		description: "Nodes and edges within depth 1 or 2 of a node. Bounded. Read-only.",
		input: strict({ id, depth: z.number().int().min(1).max(2).optional() }),
	},
	list_lectures: {
		title: "List lectures",
		description: "Registered lectures with counts; chapter (a chapter number) keeps one chapter. Read-only.",
		input: strict({ chapter: z.number().int().min(1).max(100_000).optional() }),
	},
	get_lecture: {
		title: "Read one lecture outline",
		description: "Outline, referenced nodes and timed exercises. Slide narration text is never returned. Read-only.",
		input: strict({ id }),
	},
	list_goals: {
		title: "List study goals",
		description: "Goals with scope size and the share of solid nodes. Study-state group (disabled by --knowledge-only). Read-only.",
		input: strict({ status: z.enum(["active", "paused", "reached"]).optional(), limit }),
	},
	get_goal: {
		title: "Read one study goal",
		description: "Scope summary, due counts and the state of the exercise set. Study-state group. Read-only.",
		input: strict({ id }),
	},
	get_daily_plan: {
		title: "Read the daily study plan",
		description:
			"Budget in minutes, due counts per channel, estimated minutes, new-card quota and whether an exercise set is pending, computed by the app's own plan function. date (YYYY-MM-DD, server local time) may be today or up to 30 days ahead. Study-state group. Read-only.",
		input: strict({ date: z.string().length(10).optional() }),
	},
	research_status: {
		title: "Read research status",
		description: "Frontier marks, inbox size and a summary of the last research cycle. Study-state group. Read-only.",
		input: strict({}),
	},
	get_recent_debriefs: {
		title: "Read recent session debriefs",
		description:
			"Newest-first session debriefs and the latest weekly synthesis with their computed facts and commentary. since is an ISO-8601 instant with a time zone. Study-state group. Read-only.",
		input: strict({
			limit: z.number().int().min(1).max(LIMITS.debriefsMax).optional(),
			since: z.string().min(10).max(40).optional(),
			kind: z.enum(DEBRIEF_KINDS).optional(),
		}),
	},
	list_documents: {
		title: "List registered documents",
		description: "Registered PDFs with title, page count and reading progress. Study-state group. Read-only.",
		input: strict({}),
	},
};
