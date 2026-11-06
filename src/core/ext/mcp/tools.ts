// src/core/ext/mcp/tools.ts
/**
 * The tool table and its dispatcher. runTool is the single entry the server
 * calls; it is also the core's own gatekeeper, independent of the SDK layer:
 *   1. an unknown tool name (including inherited names such as "constructor")
 *      is refused;
 *   2. the format stamps are checked FIRST, so a newer stamp answers every tool
 *      with the same clear error (REQ-mcp-03);
 *   3. the study group is refused under --knowledge-only (REQ-mcp-06);
 *   4. the arguments must be a plain object holding only the tool's declared
 *      fields: an unknown field is refused, never ignored, so a write-shaped
 *      request (`{"id": "n_1", "delete": true}`) cannot slip through.
 */

import { openCall, type Call } from "./call.ts";
import { ToolError, invalid } from "./errors.ts";
import { getDailyPlan } from "./plan.ts";
import { getGoal, listGoals } from "./goals.ts";
import { plainObject } from "./input.ts";
import { getLecture, listLectures } from "./lectures.ts";
import { capText } from "./limits.ts";
import { getNeighbors, getNode } from "./node.ts";
import type { McpDeps, RunOptions } from "./ports.ts";
import { researchStatus } from "./research.ts";
import { searchNodes } from "./search.ts";

export type ToolGroup = "knowledge" | "study";

interface Handler {
	group: ToolGroup;
	/** The only argument names the tool accepts (a test pins them to the zod schemas of the catalog). */
	fields: readonly string[];
	run(call: Call, input: Record<string, unknown>, opts: RunOptions): unknown;
}

const HANDLERS: Record<string, Handler> = {
	search_nodes: { group: "knowledge", fields: ["query", "limit", "trust", "goalId"], run: searchNodes },
	get_node: { group: "knowledge", fields: ["id"], run: getNode },
	get_neighbors: { group: "knowledge", fields: ["id", "depth"], run: (c, i) => getNeighbors(c, i) },
	list_lectures: { group: "knowledge", fields: ["chapter"], run: (c, i) => listLectures(c, i) },
	get_lecture: { group: "knowledge", fields: ["id"], run: (c, i) => getLecture(c, i) },
	list_goals: { group: "study", fields: ["status", "limit"], run: (c, i) => listGoals(c, i) },
	get_goal: { group: "study", fields: ["id"], run: (c, i) => getGoal(c, i) },
	get_daily_plan: { group: "study", fields: ["date"], run: (c, i) => getDailyPlan(c, i) },
	research_status: { group: "study", fields: [], run: (c) => researchStatus(c) },
};

export const TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(HANDLERS));

export function toolGroup(name: string): ToolGroup | null {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.group : null;
}

export function toolFields(name: string): readonly string[] {
	return Object.hasOwn(HANDLERS, name) ? HANDLERS[name]!.fields : [];
}

export function runTool(name: string, deps: McpDeps, input: unknown, opts: RunOptions): unknown {
	if (!Object.hasOwn(HANDLERS, name)) throw new ToolError("not_found", `Unknown tool "${capText(name, 60)}".`);
	const handler = HANDLERS[name]!;
	const call = openCall(deps); // stamps first
	if (opts.knowledgeOnly && handler.group === "study") {
		throw new ToolError("disabled", "Study-state tools are disabled (--knowledge-only).");
	}
	const args = plainObject(input);
	for (const key of Object.keys(args)) {
		if (!handler.fields.includes(key)) {
			const accepted = handler.fields.length === 0 ? "no arguments" : handler.fields.join(", ");
			throw invalid(`Unknown argument "${capText(key, 40)}". This server is read-only; ${name} accepts: ${accepted}.`);
		}
	}
	return handler.run(call, args, opts);
}
