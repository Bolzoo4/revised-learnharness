// src/server/ext/agent-goals.ts
/**
 * The study agent's endpoints (REQ-graph-agent-08, 10, 11, 12, 18, 22, 23, 25): create a goal with its target
 * statements and attached PDFs, read the sandbox folder, set a goal's weights, and create a typed link. The
 * attached PDFs are named files of the sandbox folder; each is checked and read before the first write. Pure
 * service over injected ports; the live wiring is agent-goals-live.ts. Every refusal is decided before the first
 * write, and a goal created here never marks anything learned.
 */

import { createHash, randomBytes } from "node:crypto";
import { getGraph, mergeFindings, type GraphDeps } from "../../core/graph.ts";
import { matchExistingNode } from "../../core/ext/target-match.ts";
import type { SessionFindings } from "../../core/contracts.ts";
import type { CostGate, SpendHold } from "../../core/ext/cost-gate.ts";
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
import type { Page } from "../../core/ext/mcp/limits.ts";
import { SANDBOX_MAX_FILES, type SandboxFile, type SandboxRefusal } from "../../core/ext/sandbox.ts";

export const MAX_TITLE_CHARS = 200;
export const MAX_TARGETS = 20;
export const MAX_TARGET_CHARS = 500;
export const MAX_FILES = SANDBOX_MAX_FILES;
/** Estimated spend per imported PDF: the notes pipeline does not report its billed total (see research-live.ts). */
export const ESTIMATED_IMPORT_USD_PER_FILE = 0.05;
/** Estimated spend of one identity judgement (the auditor call over the unmatched targets), a constant like the import estimate. */
export const ESTIMATED_IDENTITY_USD_PER_CALL = 0.02;

/** An attached file: the name of a file in the sandbox folder, nothing else (REQ-graph-agent-23). */
export interface AgentFile {
	name: string;
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

/** The sandbox folder: its path, its listing, and one checked read of a named file (live: sandbox-live.ts). */
export interface SandboxPort {
	root(): string;
	list(): Promise<Page<SandboxFile>>;
	read(name: string): Promise<{ ok: true; bytes: Uint8Array } | SandboxRefusal>;
}

/** The agent kind's ceiling: checked and reserved in one step, so concurrent requests share it (REQ-graph-agent-18). */
export interface AgentSpendGate {
	allowed(): boolean;
	reserve(usd: number, source: string): SpendHold | null;
}

/** A created goal, or the one an identical earlier request made (reused: true). */
export type AgentCreated = {
	goalId: string;
	nodeIds: string[];
	reused: boolean;
	/** Targets attached to existing nodes (by the cheap match or the judgement). */
	matchedExisting: number;
	/** False when a target needed a judgement that could not be made: those targets became new nodes. */
	identityChecked: boolean;
};

/** Judges the targets that the cheap match did not settle, against the existing graph (REQ-graph-agent-27). */
export interface IdentityPort {
	/** Index (into the statements given) to the existing node that statement IS, or null when it is new. Throws when no judgement can be made. */
	identify(statements: string[]): Promise<Map<number, string | null>>;
}


export interface AgentGoalsDeps {
	graphStore: GraphStore;
	goalsStore: GoalsStore;
	linksStore: { readLinks(): Link[]; appendLink(input: { from: string; to: string; linkType: LinkType; origin: LinkOrigin }, nodeIds: ReadonlySet<string>): Link };
	gate: AgentSpendGate;
	documents: DocumentImportPort;
	sandbox: SandboxPort;
	/** The identity judge; absent when no model is configured (every unmatched target then becomes a new node). */
	identity?: IdentityPort;
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

/** The merger is chat-store-free; if it ever reaches for one, fail loudly (the same guard as goal-service.ts). */
const noChatStore = new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(`agent goals: chatStore.${String(prop)} is not available to the merger`);
		},
	},
) as ChatStore;

/** The name of one attached file. An entry is { name } and nothing else: the old { name, dataBase64 } shape is refused. */
function nameOf(index: number, file: unknown): string | AgentFailure {
	const f = file as Record<string, unknown> | null;
	if (typeof f !== "object" || f === null || Array.isArray(f) || typeof f.name !== "string" || Object.keys(f).some((key) => key !== "name")) {
		return fail(400, `files[${index}] must be an object with a name only; attached files are read from the sandbox folder`);
	}
	return f.name;
}

/** How a refusal names its file: the index, and the name unless the name is absolute (an absolute name would carry a path). */
function fileLabel(index: number, name: string): string {
	const shown = name.startsWith("/") || name.includes("\0") ? "" : ` "${name.slice(0, 200)}"`;
	return `files[${index}]${shown}`;
}

/** Validates the whole input, returning the file names or the first refusal. Pure: no reads, no writes. */
function validateCreate(input: AgentGoalInput): AgentFailure | { title: string; targets: string[]; names: string[]; weights?: Record<string, number>; priority: number } {
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
	const names: string[] = [];
	for (const [i, file] of files.entries()) {
		const name = nameOf(i, file);
		if (typeof name !== "string") return name;
		names.push(name);
	}
	const priority = input.priority ?? DEFAULT_GOAL_PRIORITY;
	if (!isValidGoalPriority(priority)) return fail(400, `priority must be an integer from ${MIN_GOAL_PRIORITY} to ${MAX_GOAL_PRIORITY}`);
	let weights: Record<string, number> | undefined;
	if (input.weights !== undefined) {
		const w = validateWeights(input.weights);
		if (!w.ok) return fail(400, "weights are not valid", w.problems);
		weights = w.weights;
	}
	return { title: input.title, targets, names, weights, priority };
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

/** GET /api/ext/agent/sandbox: the sandbox folder's absolute path and the page of files in it (REQ-graph-agent-22). */
export async function readAgentSandbox(deps: { sandbox: SandboxPort }): Promise<AgentResult<{ path: string; files: Page<SandboxFile> }>> {
	return { ok: true, path: deps.sandbox.root(), files: await deps.sandbox.list() };
}

/**
 * The idempotency key of an agent goal: the title, the sorted target statements and the attached files (name and
 * size, sorted). The same request always gives the same key (REQ-graph-agent-08).
 */
export function agentGoalKey(input: { title: string; targets: string[]; files: Array<{ name: string; size: number }> }): string {
	const files = input.files.map((f) => [f.name, f.size] as const).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
	return createHash("sha256")
		.update(JSON.stringify([input.title, [...input.targets].sort(), files]))
		.digest("hex");
}

/** Requests being served now, by key: an identical request that arrives meanwhile joins the first one, never a second goal. */
const inFlight = new Map<string, Promise<AgentResult<AgentCreated>>>();
const NO_HOLD: SpendHold = { commit: () => undefined, release: () => undefined };

/** How the targets were identified: the index of each target that is an existing node, and whether every target that needed a judgement got one. */
interface TargetIdentity {
	matches: Map<number, string>;
	checked: boolean;
}

/**
 * The identity pass over the targets (REQ-graph-agent-27). The cheap exact match runs first and spares the model; the
 * statements it does not settle go to the judge, whose verdicts are kept only when they name a node of the graph.
 * Without a judge, or when it fails, or when its spend cannot be reserved, the rest stay new (checked: false) and the
 * goal is still created. Its estimated spend is reserved before the call and committed after it.
 */
async function identifyTargets(targets: readonly string[], deps: AgentGoalsDeps): Promise<TargetIdentity> {
	const nodes = getGraph(deps.graphStore).nodes;
	const known = new Set(nodes.map((n) => n.id));
	const matches = new Map<number, string>();
	targets.forEach((statement, i) => {
		const id = matchExistingNode(statement, nodes);
		if (id !== null) matches.set(i, id);
	});
	const unmatched = targets.map((_, i) => i).filter((i) => !matches.has(i));
	if (unmatched.length === 0) return { matches, checked: true };
	if (deps.identity === undefined) return { matches, checked: false };
	const hold = deps.gate.reserve(ESTIMATED_IDENTITY_USD_PER_CALL, AGENT_SPEND_SOURCE);
	if (hold === null) return { matches, checked: false };
	try {
		const judged = await deps.identity.identify(unmatched.map((i) => targets[i]!));
		unmatched.forEach((targetIndex, k) => {
			const nodeId = judged.get(k);
			if (typeof nodeId === "string" && known.has(nodeId)) matches.set(targetIndex, nodeId);
		});
		hold.commit();
		return { matches, checked: true };
	} catch {
		return { matches, checked: false };
	} finally {
		hold.release();
	}
}

/** Creates the goal, its nodes and its spend holds: the PDF import (one hold), then the identity pass, then the merge. */
async function performCreate(checked: { title: string; targets: string[]; weights?: Record<string, number>; priority: number }, attached: Uint8Array[], key: string, deps: AgentGoalsDeps): Promise<AgentResult<AgentCreated>> {
	const hold = attached.length > 0 ? deps.gate.reserve(attached.length * ESTIMATED_IMPORT_USD_PER_FILE, AGENT_SPEND_SOURCE) : NO_HOLD;
	if (hold === null) return fail(429, "the daily spending ceiling for agent work is reached; try again tomorrow");
	try {
		const now = (deps.now ?? (() => new Date().toISOString()))();
		const goalId = (deps.newGoalId ?? newGoalId)();

		const sourceIds = new Set<string>();
		for (const bytes of attached) sourceIds.add((await deps.documents.importPdf(bytes)).sourceId);
		const fileNodeIds = nodeIdsWithProvenance(deps.graphStore, (id) => sourceIds.has(id));

		const identity = await identifyTargets(checked.targets, deps);
		const findings: SessionFindings = {
			propositions: checked.targets.map((statement, i) => ({ id: `p${i + 1}`, name: statement.slice(0, 120), statement, aliases: [] })),
			chains: [],
		};
		const links = [...identity.matches].map(([index, nodeId]) => ({ id: `p${index + 1}`, linkTo: nodeId }));
		mergeFindings(goalId, findings, { links }, { chatStore: noChatStore, graphStore: deps.graphStore } as GraphDeps, { foldedAt: now });
		const targetNodeIds = [...new Set(nodeIdsWithProvenance(deps.graphStore, (id) => id === goalId))];
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
			idemKey: key,
			matchedExisting: identity.matches.size,
			identityChecked: identity.checked,
			at: now,
		});
		hold.commit();
		return {
			ok: true,
			goalId,
			nodeIds: [...new Set([...targetNodeIds, ...fileNodeIds])],
			reused: false,
			matchedExisting: identity.matches.size,
			identityChecked: identity.checked,
		};
	} finally {
		hold.release();
	}
}

/**
 * POST /api/ext/agent/goals. Validation first (400, nothing written); then every named file is read from the sandbox
 * (400 naming the first refused file, nothing imported). A goal already made with the same key is answered with
 * reused: true and no work or spend; an identical request still running is joined. Otherwise the ceiling is checked
 * and the spend reserved in one synchronous step (429 when it would be exceeded), before any import.
 */
export async function createAgentGoal(input: AgentGoalInput, deps: AgentGoalsDeps): Promise<AgentResult<AgentCreated>> {
	let checked: ReturnType<typeof validateCreate>;
	try {
		checked = validateCreate(input);
	} catch (e) {
		if (e instanceof AgentRefusal) return e.failure;
		throw e;
	}
	if ("ok" in checked) return checked;

	const attached: Uint8Array[] = [];
	for (const [i, name] of checked.names.entries()) {
		const read = await deps.sandbox.read(name);
		if (!read.ok) return fail(400, `${fileLabel(i, name)} ${read.reason}`);
		attached.push(read.bytes);
	}
	const key = agentGoalKey({ title: checked.title, targets: checked.targets, files: attached.map((bytes, i) => ({ name: checked.names[i]!, size: bytes.byteLength })) });

	const existing = deps.goalsStore.readEvents().find((e) => e.type === "created" && e.origin === "agent" && e.idemKey === key);
	if (existing?.type === "created") {
		return {
			ok: true,
			goalId: existing.goalId,
			nodeIds: [...existing.targetNodeIds],
			reused: true,
			matchedExisting: existing.matchedExisting ?? 0,
			identityChecked: existing.identityChecked ?? false,
		};
	}

	const running = inFlight.get(key);
	if (running !== undefined) {
		const answer = await running;
		return answer.ok ? { ...answer, reused: true } : answer;
	}
	if (!gateOpen(deps.gate)) return fail(429, "the daily spending ceiling for agent work is reached; try again tomorrow");

	const work = performCreate(checked, attached, key, deps);
	inFlight.set(key, work);
	try {
		return await work;
	} finally {
		inFlight.delete(key);
	}
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
