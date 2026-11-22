// src/core/ext/mcp/write.ts
/**
 * The agent write tools (REQ-graph-agent-16): create_goal, set_goal_weights and
 * create_link. They validate the arguments here, read the local PDFs for
 * create_goal, and hand the result to the app's own endpoints through the
 * injected AppApiPort. The server never writes the data itself; the app does.
 */

import fs from "node:fs";
import path from "node:path";
import { LINK_TYPES } from "../links.ts";
import type { Call } from "./call.ts";
import { invalid } from "./errors.ts";
import { optionalEnum, requireId, requireText } from "./input.ts";
import { LIMITS } from "./limits.ts";

export const WRITE_LIMITS = Object.freeze({
	targetsMax: 20,
	targetChars: 500,
	filesMax: 5,
	fileBytesMax: 20 * 1024 * 1024,
	pathChars: 1024,
	fileNameChars: 200,
	priorityMin: 1,
	priorityMax: 5,
});

const PDF_MAGIC = "%PDF-";

function plainObject(value: unknown, field: string): Record<string, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} must be an object of key to number.`);
	const out: Record<string, number> = {};
	for (const [key, v] of Object.entries(value)) {
		if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${field}.${requireText(key, "weight key", 60)} must be a number.`);
		out[key] = v;
	}
	return out;
}

/** One attached PDF, read and base64-encoded. Every refusal is decided before the app is called and names no path. */
function readPdf(index: number, file: unknown): { name: string; dataBase64: string } {
	const f = file as { name?: unknown; path?: unknown } | null;
	if (typeof f !== "object" || f === null || Array.isArray(f)) throw invalid(`files[${index}] must be an object with name and path.`);
	const name = requireText(f.name, `files[${index}].name`, WRITE_LIMITS.fileNameChars);
	if (!name.toLowerCase().endsWith(".pdf")) throw invalid(`files[${index}].name must end in .pdf.`);
	if (typeof f.path !== "string" || f.path.length > WRITE_LIMITS.pathChars || f.path.includes("\0")) {
		throw invalid(`files[${index}].path must be a string of at most ${WRITE_LIMITS.pathChars} characters without NUL.`);
	}
	if (!path.isAbsolute(f.path)) throw invalid(`files[${index}].path must be an absolute path.`);
	let size: number;
	try {
		const st = fs.statSync(f.path);
		if (!st.isFile()) throw new Error("not a file");
		size = st.size;
	} catch {
		throw invalid(`files[${index}] cannot be read: no file at that path.`);
	}
	if (size > WRITE_LIMITS.fileBytesMax) throw invalid(`files[${index}] is over the 20 MB limit.`);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(f.path);
	} catch {
		throw invalid(`files[${index}] cannot be read.`);
	}
	if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) throw invalid(`files[${index}] is not a PDF.`);
	return { name, dataBase64: bytes.toString("base64") };
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
		if (input.files.length > WRITE_LIMITS.filesMax) throw invalid(`files must contain at most ${WRITE_LIMITS.filesMax} PDFs.`);
		body.files = input.files.map((file, i) => readPdf(i, file));
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
