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
import { LINK_TYPES } from "../../../core/ext/links.ts";
import { WRITE_LIMITS } from "../../../core/ext/mcp/write.ts";

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
			"Fuzzy text search over node names, statements and aliases. Returns id, name, a shortened statement, the trust level and the stage (staged, unrevised or confirmed). stage filters before the limit: the default is confirmed (settled nodes only); use all to include staged and unrevised nodes. Read-only.",
		input: strict({
			query: z.string().min(1).max(LIMITS.queryMaxChars),
			limit,
			trust: z.enum(["unverified", "sourced", "contested", "refuted"]).optional(),
			goalId: id.optional(),
			stage: z.enum(["staged", "unrevised", "confirmed", "all"]).optional(),
		}),
	},
	get_node: {
		title: "Read one knowledge node",
		description:
			"Statement, aliases, trust level with evidence, the stage (staged, unrevised or confirmed; null under --knowledge-only), the current explanation (flagged stale or without source context), premises, conclusions, alternative arguments, citing lectures (null with citingLecturesOmitted true while the lecture index is still being built), card count, review state and goals. Read-only.",
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
		description:
			"Outline (each slide with the nodes its blocks cite and the nodes linked in its own text), referenced nodes and timed exercises. Slide narration text is never returned. Read-only.",
		input: strict({ id }),
	},
	list_goals: {
		title: "List study goals",
		description: "Goals with scope size, the share of solid nodes and per-stage counts (staged, unrevised, confirmed) of the scope. Study-state group (disabled by --knowledge-only). Read-only.",
		input: strict({ status: z.enum(["active", "paused", "reached"]).optional() }),
	},
	get_goal: {
		title: "Read one study goal",
		description: "Scope summary, per-stage counts of the scope, due counts and the state of the exercise set. Study-state group. Read-only.",
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
		description: "Frontier marks, inbox size and a summary of the last research cycle. No cost figures are reported. Study-state group. Read-only.",
		input: strict({}),
	},
	get_recent_debriefs: {
		title: "Read recent session debriefs",
		description:
			"Newest-first session debriefs and the latest weekly synthesis, with their facts when small (facts over 4 KiB are replaced by a marker) and their commentary. since is an ISO-8601 instant with a time zone. Study-state group. Read-only.",
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
	create_goal: {
		title: "Create a study goal",
		description:
			"Use when the learner asks to start learning a topic. Creates a goal from a title, optional target statements the goal must reach (up to 20; the app needs at least one), optional PDFs named relative to the agent sandbox folder (up to 5 names from get_sandbox; the app reads each file, which must be a PDF of at most 20 MB, and the file stays where it is), optional weights per link type and a priority from 1 to 5. Returns goalId, nodeIds and reused (true when an identical request already made the goal, so nothing was done again). Can take minutes while the PDFs are read; if it times out, call list_goals before trying again. Needs the running LearnHarness app. A refusal from the app (for example the daily agent spending ceiling) is returned as is. Writes through the app only.",
		input: strict({
			title: z.string().min(1).max(LIMITS.titleChars),
			targets: z.array(z.string().min(1).max(WRITE_LIMITS.targetChars)).max(WRITE_LIMITS.targetsMax).optional(),
			files: z
				.array(strict({ name: z.string().min(1).max(WRITE_LIMITS.fileNameChars) }))
				.max(WRITE_LIMITS.filesMax)
				.optional(),
			weights: z.record(z.string(), z.number()).optional(),
			priority: z.number().int().min(WRITE_LIMITS.priorityMin).max(WRITE_LIMITS.priorityMax).optional(),
		}),
	},
	set_goal_weights: {
		title: "Set a goal's link weights",
		description:
			"Use when the learner wants more or less emphasis on one kind of link (chain, evolution, sequence, case-of, part-of, analogy, contrast) for a goal. weights is a partial object of key to number; the app merges it onto the goal's current weights. Needs the running LearnHarness app. Writes through the app only.",
		input: strict({
			goalId: z.string().min(1).max(LIMITS.idMaxChars),
			weights: z.record(z.string(), z.number()),
		}),
	},
	create_link: {
		title: "Create a typed link between two nodes",
		description:
			"Use when two existing nodes are related in a way the graph does not yet show (ids come from search_nodes). linkType is one of evolution, sequence, case-of, part-of, analogy, contrast; directed types read from -> to. Needs the running LearnHarness app. Writes through the app only.",
		input: strict({
			from: z.string().min(1).max(LIMITS.idMaxChars),
			to: z.string().min(1).max(LIMITS.idMaxChars),
			linkType: z.enum(LINK_TYPES),
		}),
	},
	get_sandbox: {
		title: "Read the agent sandbox folder",
		description:
			"Use before create_goal to see which PDFs can be attached. Returns the absolute path of the agent sandbox folder and its files (relative name, size in bytes, modification time as ISO-8601), recursively to depth 3, at most 200 entries; PDFs and other files are both listed. Move a document into that folder first, then name it in create_goal. Needs the running LearnHarness app. Read-only.",
		input: strict({}),
	},
};
