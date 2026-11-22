// src/core/ext/mcp/write.ts
/**
 * The agent write tools (REQ-graph-agent-16, 23): create_goal, set_goal_weights and
 * create_link, and the sandbox listing get_sandbox (REQ-graph-agent-22). They validate
 * the arguments here and hand the request to the app's own endpoints through the
 * injected AppApiPort. This module reads no local file and no path: an attached PDF is
 * named relative to the agent sandbox folder, and the app reads it. The server never
 * writes the data itself; the app does.
 */

import { LINK_TYPES } from "../links.ts";
import type { Call } from "./call.ts";
import { invalid } from "./errors.ts";
import { optionalEnum, requireId, requireText } from "./input.ts";
import { LIMITS } from "./limits.ts";

export const WRITE_LIMITS = Object.freeze({
	targetsMax: 20,
	targetChars: 500,
	filesMax: 5,
	fileNameChars: 200,
	priorityMin: 1,
	priorityMax: 5,
});

function plainObject(value: unknown, field: string): Record<string, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object of key to number.`);
	const out: Record<string, number> = {};
	for (const [key, v] of Object.entries(value)) {
		if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${field}.${requireText(key, "weight key", 60)} must be a number.`);
		out[key] = v;
	}
	return out;
}

/** One attached file: the name of a file in the sandbox folder, and nothing else (a path or any payload is refused). */
function sandboxName(index: number, file: unknown): { name: string } {
	const f = file as Record<string, unknown> | null;
	if (typeof f !== "object" || f === null || Array.isArray(f)) throw invalid(`files[${index}] must be an object with a name.`);
	if (Object.keys(f).some((key) => key !== "name")) throw invalid(`files[${index}] takes a name only: the file is read from the agent sandbox folder.`);
	return { name: requireText(f.name, `files[${index}].name`, WRITE_LIMITS.fileNameChars) };
}

/** POST /api/ext/agent/goals. Only the fields the agent gave are sent. */
export async function createGoal(call: Call, input: Record<string, unknown>): Promise<unknown> {
	const title = requireText(input.title, "title", LIMITS.titleChars);
	const body: Record<string, unknown> = { title };
	if (input.targets !== undefined) {
		if (!Array.isArray(input.targets)) throw invalid("targets must be an array of statements.");
		if (input.targets.length > WRITE_LIMITS.targetsMax) throw invalid(`targets must contain at most ${WRITE_LIMITS.targetsMax} statements.`);
		body.targets = input.targets.map((t, i) => requireText(t, `targets[${i}]`, WRITE_LIMITS.targetChars));
	}
	if (input.files !== undefined) {
		if (!Array.isArray(input.files)) throw invalid("files must be an array.");
		if (input.files.length > WRITE_LIMITS.filesMax) throw invalid(`files must contain at most ${WRITE_LIMITS.filesMax} names.`);
		body.files = input.files.map((file, i) => sandboxName(i, file));
	}
	if (input.weights !== undefined) body.weights = plainObject(input.weights, "weights");
	if (input.priority !== undefined) {
		const p = input.priority;
		if (typeof p !== "number" || !Number.isInteger(p) || p < WRITE_LIMITS.priorityMin || p > WRITE_LIMITS.priorityMax) {
			throw invalid(`priority must be an integer from ${WRITE_LIMITS.priorityMin} to ${WRITE_LIMITS.priorityMax}.`);
		}
		body.priority = p;
	}
	return call.deps.appApi.post("/api/ext/agent/goals", body);
}

/** PUT /api/ext/agent/goals/<id>/weights: the partial weights the agent gave, merged by the app. */
export async function setGoalWeights(call: Call, input: Record<string, unknown>): Promise<unknown> {
	const goalId = requireId(input.goalId, "goalId");
	const weights = plainObject(input.weights, "weights");
	return call.deps.appApi.put(`/api/ext/agent/goals/${encodeURIComponent(goalId)}/weights`, weights);
}

/** POST /api/ext/agent/links: a typed link between two existing nodes. */
export async function createLink(call: Call, input: Record<string, unknown>): Promise<unknown> {
	const from = requireId(input.from, "from");
	const to = requireId(input.to, "to");
	const linkType = optionalEnum(input.linkType, LINK_TYPES, "linkType");
	if (linkType === undefined) throw invalid(`linkType must be one of: ${LINK_TYPES.join(", ")}.`);
	return call.deps.appApi.post("/api/ext/agent/links", { from, to, linkType });
}

/** GET /api/ext/agent/sandbox: the sandbox folder's absolute path and its files, as the app answers them. */
export async function getSandbox(call: Call): Promise<unknown> {
	return call.deps.appApi.get("/api/ext/agent/sandbox");
}
