// src/server/ext/agent-goals.ts
/**
 * The study agent's write endpoints (REQ-graph-agent-08, 10, 11, 12, 18): create a goal with its target
 * statements and attached PDFs, set a goal's weights, and create a typed link. Pure service over injected
 * ports; the live wiring is agent-goals-live.ts. Every refusal is decided before the first write, and a
 * goal created here never marks anything learned.
 */

import { randomBytes } from "node:crypto";
import { mergeFindings, type GraphDeps } from "../../core/graph.ts";
import type { SessionFindings } from "../../core/contracts.ts";
import type { CostGate } from "../../core/ext/cost-gate.ts";
import { AGENT_SPEND_SOURCE } from "../../core/ext/cost-gate.ts";
import {
	DEFAULT_GOAL_PRIORITY,
	deriveGoals,
	isValidGoalPriority,
	validateWeights,
	validateWeightsPatch,
	MAX_GOAL_PRIORITY,
	MIN_GOAL_PRIORITY,
	type Goal,
} from "../../core/ext/goals.ts";
import { setWeights } from "../../core/ext/goal-service.ts";
import { validateLink, type Link, type LinkOrigin, type LinkType } from "../../core/ext/links.ts";
import type { GoalsStore } from "../../core/ext/ports.ts";
import type { GraphStore, ChatStore } from "../../core/ports.ts";

export const MAX_TITLE_CHARS = 200;
export const MAX_TARGETS = 20;
export const MAX_TARGET_CHARS = 500;
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Estimated spend per imported PDF: the notes pipeline does not report its billed total (see research-live.ts). */
export const ESTIMATED_IMPORT_USD_PER_FILE = 0.05;

export interface AgentFile {
	name: string;
	dataBase64: string;
}

export interface AgentGoalInput {
	title: string;
	targets?: string[];
	files?: AgentFile[];
	weights?: unknown;
	priority?: number;
}

export type AgentFailure = { ok: false; status: 400 | 404 | 429; message: string; problems?: string[] };
export type AgentResult<T> = ({ ok: true } & T) | AgentFailure;

/** Stores an attached PDF like a user upload and runs the notes extraction on it; resolves the source id its nodes carry. */
export interface DocumentImportPort {
	importPdf(bytes: Uint8Array): Promise<{ sourceId: string }>;
}

export interface AgentGoalsDeps {
	graphStore: GraphStore;
	goalsStore: GoalsStore;
	linksStore: { readLinks(): Link[]; appendLink(input: { from: string; to: string; linkType: LinkType; origin: LinkOrigin }, nodeIds: ReadonlySet<string>): Link };
	gate: Pick<CostGate, "allowed" | "record">;
	documents: DocumentImportPort;
	now?: () => string;
	newGoalId?: () => string;
}

const fail = (status: AgentFailure["status"], message: string, problems?: string[]): AgentFailure => ({
	ok: false,
	status,
	message,
	...(problems ? { problems } : {}),
});

const newGoalId = () => `goal_${randomBytes(6).toString("hex")}`;
const PDF_MAGIC = "%PDF-";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The merger is chat-store-free; if it ever reaches for one, fail loudly (the same guard as goal-service.ts). */
const noChatStore = new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(`agent goals: chatStore.${String(prop)} is not available to the merger`);
		},
	},
) as ChatStore;

/** Decoded bytes of a base64 string, or null when it is not base64 or is over the cap. */
function decodeFile(index: number, file: unknown): { bytes: Uint8Array; problem?: never } | AgentFailure {
	const f = file as Partial<AgentFile> | null;
	if (typeof f !== "object" || f === null || typeof f.dataBase64 !== "string") {
		return fail(400, `files[${index}].dataBase64 must be a base64 string`);
	}
	const text = f.dataBase64;
	if (text.length % 4 !== 0 || !BASE64.test(text)) return fail(400, `files[${index}].dataBase64 must be valid base64`);
	const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
	if ((text.length * 3) / 4 - padding > MAX_FILE_BYTES) return fail(400, `files[${index}] is over the 20 MB limit`);
	const bytes = new Uint8Array(Buffer.from(text, "base64"));
	if (new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) return fail(400, `files[${index}] is not a PDF`);
	return { bytes };
}

/** Validates the whole input, returning the decoded files or the first refusal. Pure: no writes. */
function validateCreate(input: AgentGoalInput): AgentFailure | { title: string; targets: string[]; files: Uint8Array[]; weights?: Record<string, number>; priority: number } {
	if (typeof input.title !== "string" || input.title.trim() === "" || [...input.title].length > MAX_TITLE_CHARS) {
		return fail(400, `title must be a non-empty string of at most ${MAX_TITLE_CHARS} characters`);
	}
	const targets = input.targets ?? [];
	if (!Array.isArray(targets)) return fail(400, "targets must be an array of statements");
	if (targets.length === 0) return fail(400, "targets must contain at least one statement (a goal always has a target node)");
	if (targets.length > MAX_TARGETS) return fail(400, `targets must contain at most ${MAX_TARGETS} statements`);
	targets.forEach((t, i) => {
		if (typeof t !== "string" || t.trim() === "" || [...t].length > MAX_TARGET_CHARS) {
			throw new AgentRefusal(fail(400, `targets[${i}] must be a non-empty string of at most ${MAX_TARGET_CHARS} characters`));
		}
	});
	const files = input.files ?? [];
	if (!Array.isArray(files)) return fail(400, "files must be an array");
	if (files.length > MAX_FILES) return fail(400, `files must contain at most ${MAX_FILES} PDFs`);
	const bytes: Uint8Array[] = [];
	for (const [i, file] of files.entries()) {
		const decoded = decodeFile(i, file);
		if ("ok" in decoded) return decoded;
		bytes.push(decoded.bytes);
	}
	const priority = input.priority ?? DEFAULT_GOAL_PRIORITY;
	if (!isValidGoalPriority(priority)) return fail(400, `priority must be an integer from ${MIN_GOAL_PRIORITY} to ${MAX_GOAL_PRIORITY}`);
	let weights: Record<string, number> | undefined;
	if (input.weights !== undefined) {
		const w = validateWeights(input.weights);
		if (!w.ok) return fail(400, "weights are not valid", w.problems);
		weights = w.weights;
	}
	return { title: input.title, targets, files: bytes, weights, priority };
}

/** Thrown inside the target check only so a forEach can stop with a refusal; caught in createAgentGoal. */
class AgentRefusal extends Error {
	constructor(readonly failure: AgentFailure) {
		super(failure.message);
	}
}

function gateOpen(gate: Pick<CostGate, "allowed">): boolean {
	try {
		return gate.allowed();
	} catch {
		return false;
	}
}

function nodeIdsWithProvenance(graphStore: GraphStore, pick: (chatId: string) => boolean): string[] {
	return graphStore
		.readNodes()
		.filter((n) => n.provenance.some((p) => pick(p.chatId)))
		.map((n) => n.id);
}

/** POST /api/ext/agent/goals. Gate first (429, nothing written), then validation (400, nothing written), then the writes. */
export async function createAgentGoal(input: AgentGoalInput, deps: AgentGoalsDeps): Promise<AgentResult<{ goalId: string; nodeIds: string[] }>> {
	if (!gateOpen(deps.gate)) return fail(429, "the daily spending ceiling for agent work is reached; try again tomorrow");
	let checked: ReturnType<typeof validateCreate>;
	try {
		checked = validateCreate(input);
	} catch (e) {
		if (e instanceof AgentRefusal) return e.failure;
		throw e;
	}
	if ("ok" in checked) return checked;

	const now = (deps.now ?? (() => new Date().toISOString()))();
	const goalId = (deps.newGoalId ?? newGoalId)();

	const sourceIds = new Set<string>();
	for (const bytes of checked.files) sourceIds.add((await deps.documents.importPdf(bytes)).sourceId);
	const fileNodeIds = nodeIdsWithProvenance(deps.graphStore, (id) => sourceIds.has(id));

	const findings: SessionFindings = {
		propositions: checked.targets.map((statement, i) => ({ id: `p${i + 1}`, name: statement.slice(0, 120), statement, aliases: [] })),
		chains: [],
	};
	mergeFindings(goalId, findings, { links: [] }, { chatStore: noChatStore, graphStore: deps.graphStore } as GraphDeps, { foldedAt: now });
	const targetNodeIds = nodeIdsWithProvenance(deps.graphStore, (id) => id === goalId);
	if (targetNodeIds.length === 0) throw new Error("agent goals: the merger did not create the target nodes");

	deps.goalsStore.appendEvent({
		type: "created",
		goalId,
		title: checked.title,
		origin: "agent",
		originRef: checked.title,
		targetNodeIds,
		priority: checked.priority,
		...(checked.weights ? { weights: checked.weights as Goal["weights"] } : {}),
		at: now,
	});
	if (checked.files.length > 0) deps.gate.record(checked.files.length * ESTIMATED_IMPORT_USD_PER_FILE, AGENT_SPEND_SOURCE);
	return { ok: true, goalId, nodeIds: [...new Set([...targetNodeIds, ...fileNodeIds])] };
}

/** PUT /api/ext/agent/goals/[id]/weights: partial weights merged onto the goal's current ones. */
export function setAgentGoalWeights(goalId: string, raw: unknown, deps: AgentGoalsDeps): AgentResult<{ goal: Goal }> {
	const goalDeps = { graphStore: deps.graphStore, goalsStore: deps.goalsStore, now: deps.now };
	const current = deriveGoals(deps.goalsStore.readEvents()).find((g) => g.id === goalId);
	if (current === undefined) return fail(404, `unknown goal ${goalId}`);
	const patch = validateWeightsPatch(raw);
	if (!patch.ok) return fail(400, "weights are not valid", patch.problems);
	return { ok: true, goal: setWeights(goalId, raw, goalDeps) };
}

/** POST /api/ext/agent/links: a typed link between two existing nodes, origin agent. */
export function createAgentLink(input: { from: unknown; to: unknown; linkType: unknown }, deps: AgentGoalsDeps): AgentResult<{ link: Link }> {
	for (const field of ["from", "to", "linkType"] as const) {
		if (typeof input[field] !== "string" || input[field] === "") return fail(400, `${field} must be a non-empty string`);
	}
	const candidate = { from: input.from as string, to: input.to as string, linkType: input.linkType as string };
	const nodeIds = new Set(deps.graphStore.readNodes().map((n) => n.id));
	const problems = validateLink(candidate, nodeIds, deps.linksStore.readLinks());
	if (problems.length > 0) return fail(400, "the link is not valid", problems);
	try {
		const link = deps.linksStore.appendLink({ ...candidate, linkType: candidate.linkType as LinkType, origin: "agent" }, nodeIds);
		return { ok: true, link };
	} catch (e) {
		return fail(400, e instanceof Error ? e.message : String(e));
	}
}
