// tests/helpers/mcp-fixture.ts
/**
 * A real data directory on disk for the MCP server tests. Files are written
 * with plain fs calls (the test side may write; the server never does), shaped
 * by the app's own event types so a format change breaks the fixture at
 * compile time. `seedStandard` builds one small, fully populated learner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GraphChain, GraphNode } from "../../src/core/contracts.ts";
import type { CardEvent } from "../../src/core/ext/cards.ts";
import { concludingFingerprint } from "../../src/core/ext/explanation-rules.ts";
import type { ExplanationEvent } from "../../src/core/ext/explanations.ts";
import type { FrontierEvent } from "../../src/core/ext/frontier.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { InboxEvent } from "../../src/core/ext/inbox.ts";
import type { McpDeps } from "../../src/core/ext/mcp/ports.ts";
import type { ExerciseEvent } from "../../src/core/ext/practice/exercises.ts";
import type { CycleLogEntry } from "../../src/core/ext/research-log.ts";
import type { ReviewEvent } from "../../src/core/ext/review.ts";
import type { Evidence, VerificationEvent } from "../../src/core/ext/trust.ts";
import { createMcpDeps } from "../../src/server/ext/mcp/deps.ts";
import { makeLecture } from "./lecture-fixture.ts";

export const NOW = "2026-11-04T12:00:00.000Z";
export const GOAL_ID = "goal_aaaaaaaaaaaa";
export const N = { a: "n_aaaa1111", b: "n_bbbb2222", c: "n_cccc3333", d: "n_dddd4444", lone: "n_lone5555" } as const;

/** Strings that must NEVER appear in any tool output (they sit in fields the server does not expose). */
export const HIDDEN = {
	cardAnswer: "HIDDEN_CARD_ANSWER_91",
	reference: "HIDDEN_REFERENCE_SOLUTION_92 that is long enough to be quotable",
	narration: "family closed under complements and countable unions",
	reveal: "the four listed sets are closed under both operations",
	originRef: "HIDDEN_ORIGIN_REF_93",
	localPath: "/Users/secret-person/private-books",
	urlToken: "HIDDEN_TOKEN_94",
	researchError: "HIDDEN_RESEARCH_ERROR_95",
	locator: "https://hidden-locator.example/HIDDEN_LOCATOR_96",
	steer: "HIDDEN_STEER_97",
	rationale: "HIDDEN_RATIONALE_98",
} as const;

export interface Fixture {
	root: string;
	extDir: string;
	graphDir: string;
	deps: McpDeps;
	/** Appends one raw line (an object is JSON-encoded) to <root>/ext/<file>, creating the directory. */
	ext(file: string, line: unknown): void;
	graph(file: "nodes.jsonl" | "chains.jsonl", line: unknown): void;
	writeStamp(dir: "ext" | "graph", version: number): void;
	cleanup(): void;
}

const roots: string[] = [];

export function makeFixture(clock: () => string = () => NOW): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-"));
	roots.push(root);
	const extDir = path.join(root, "ext");
	const graphDir = path.join(root, "graph");
	fs.mkdirSync(graphDir, { recursive: true });
	const line = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
	return {
		root,
		extDir,
		graphDir,
		deps: createMcpDeps(root, clock),
		ext(file, v) {
			fs.mkdirSync(extDir, { recursive: true });
			fs.appendFileSync(path.join(extDir, file), `${line(v)}\n`);
		},
		graph(file, v) {
			fs.appendFileSync(path.join(graphDir, file), `${line(v)}\n`);
		},
		writeStamp(dir, version) {
			const d = dir === "ext" ? extDir : graphDir;
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, "format.json"), JSON.stringify({ version }));
		},
		cleanup() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

export function cleanupAllFixtures(): void {
	for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
}

export const node = (id: string, name: string, statement = `${name} holds.`, aliases: string[] = []): GraphNode => ({
	id, name, statement, aliases, createdAt: "2026-11-01T00:00:00.000Z", provenance: [],
});
export const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id, premises, conclusion, provenance: [], createdAt: "2026-11-01T00:00:00.000Z",
});

export const STANDARD_NODES: GraphNode[] = [
	node(N.a, "Axiom A", "Every set is a subset of itself."),
	node(N.b, "Lemma B", "The empty set is a subset of every set."),
	node(N.c, "Theorem C", "Inclusion is a partial order on sets.", ["Subset order"]),
	node(N.d, "Corollary D", "Every family of sets has a partial order by inclusion."),
	node(N.lone, "Loner", "A node no chain mentions."),
];
// C is concluded by two chains (an alternative argument); D by one.
export const STANDARD_CHAINS: GraphChain[] = [chain("ch_1", [N.a, N.b], N.c), chain("ch_2", [N.a], N.c), chain("ch_3", [N.c], N.d)];

export function seedGraph(f: Fixture, nodes: GraphNode[] = STANDARD_NODES, chains: GraphChain[] = STANDARD_CHAINS): void {
	for (const n of nodes) f.graph("nodes.jsonl", n);
	for (const c of chains) f.graph("chains.jsonl", c);
}

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
	sourceRef: "https://example.org/set-theory",
	sourceId: "lib_0000000a",
	locator: "section 2",
	quote: "every set is a subset of itself, by reflexivity of inclusion",
	snapshot: "a".repeat(64),
	stance: "supports",
	tier: "primary",
	host: "example.org",
	...over,
});

/** A learner with goals, reviews, a card, trust, explanations, a lecture, an exercise set and research state. */
export function seedStandard(f: Fixture): void {
	seedGraph(f);
	const goal: GoalEvent = {
		type: "created", goalId: GOAL_ID, title: "Learn set order", origin: "user", originRef: HIDDEN.originRef,
		targetNodeIds: [N.d], priority: 3, at: "2026-11-01T00:00:00.000Z",
	};
	f.ext("goals.jsonl", goal);

	const reviews: ReviewEvent[] = [
		{ type: "review", nodeId: N.a, channel: "fixed", rating: 3, durationSec: 20, at: "2026-11-01T09:00:00.000Z" },
		{ type: "review", nodeId: N.b, channel: "fixed", rating: 1, durationSec: 30, at: "2026-11-03T09:00:00.000Z" },
	];
	for (const r of reviews) f.ext("review.jsonl", r);

	const card: CardEvent = {
		type: "created", cardId: "card_00000001", nodeId: N.a, question: "What is reflexivity?", answer: HIDDEN.cardAnswer,
		author: "user", status: "active", at: "2026-11-01T08:00:00.000Z",
	};
	f.ext("cards.jsonl", card);

	const checked: VerificationEvent[] = [
		{
			type: "checked", nodeId: N.a, outcome: "sourced", checker: "test:model", at: "2026-11-02T10:00:00.000Z", discarded: [],
			evidence: [evidence({ sourceRef: `https://user:pw@example.org/set-theory?token=${HIDDEN.urlToken}#frag` })],
		},
		{
			type: "checked", nodeId: N.b, outcome: "unverified", checker: "test:model", at: "2026-11-02T10:00:00.000Z", discarded: [],
			evidence: [evidence({ sourceRef: `${HIDDEN.localPath}/algebra.pdf`, sourceId: null, tier: "unvetted", host: "" })],
		},
	];
	for (const v of checked) f.ext("verification.jsonl", v);

	const expl: ExplanationEvent[] = [
		{
			type: "version", nodeId: N.c, version: 1, body: `Follows from [[${N.a}]] and [[${N.b}]].`, author: "agent", sourceRefs: [],
			styleVersion: "abc123abc123", fingerprint: concludingFingerprint(N.c, STANDARD_CHAINS), noSource: false, proposed: false,
			at: "2026-11-02T11:00:00.000Z",
		},
		{
			type: "version", nodeId: N.d, version: 1, body: "Old text.", author: "agent", sourceRefs: [], styleVersion: "abc123abc123",
			fingerprint: "stale-fingerprint", noSource: true, proposed: false, at: "2026-11-02T11:00:00.000Z",
		},
	];
	for (const e of expl) f.ext("explanations.jsonl", e);

	const lecture = makeLecture({
		blocks: makeLecture().blocks.map((b) => ({ ...b, nodeIds: b.nodeIds.map(() => N.a) })),
		slides: [
			{ id: "s1", heading: "Sigma algebra", elements: [{ id: "e1", type: "text", content: `A [[${N.a}|set]] is a family of sets.` }] },
			{ id: "s2", heading: "Looking ahead", elements: [{ id: "e2", type: "list", items: ["Brownian motion", `[[${N.b}]]`] }] },
		],
	});
	fs.mkdirSync(path.join(f.extDir, "lectures", lecture.id), { recursive: true });
	fs.writeFileSync(path.join(f.extDir, "lectures", lecture.id, "lecture.json"), JSON.stringify(lecture));

	const sets: ExerciseEvent[] = [
		{
			type: "set_created", setId: "set_1", goalId: GOAL_ID, at: "2026-11-03T10:00:00.000Z",
			exercises: [{ id: "ex_1", prompt: "Show that inclusion is transitive.", nodeIds: [N.a, N.c], steps: [{ id: "s1", text: HIDDEN.reference, nodeIds: [N.a] }] }],
		},
		{ type: "graded", setId: "set_1", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [{ nodeId: N.a, outcome: "passed" }], lowConfidence: false, at: "2026-11-03T11:00:00.000Z" },
	];
	for (const e of sets) f.ext("exercises.jsonl", e);

	const frontier: FrontierEvent = {
		type: "set", markId: "mark_1", scope: { kind: "goal", id: GOAL_ID }, mark: "expand", maxDepth: 2, budgetUsd: 1.5,
		note: "grow the set theory area", author: "user", at: "2026-11-03T12:00:00.000Z",
	};
	f.ext("frontier.jsonl", frontier);
	const inbox: InboxEvent[] = [
		{ type: "proposed", locator: HIDDEN.locator, title: "A paper", gapId: "gap_1", foundBy: "cycle", cycleId: "cyc_1", snapshot: "b".repeat(64), at: "2026-11-03T13:00:00.000Z" },
		{ type: "proposed", locator: "https://other.example/paper", title: "Another", gapId: "gap_1", foundBy: "watch", cycleId: "cyc_1", snapshot: "c".repeat(64), at: "2026-11-03T13:01:00.000Z" },
		{ type: "decided", locator: "https://other.example/paper", decision: "rejected", at: "2026-11-03T14:00:00.000Z" },
	];
	for (const e of inbox) f.ext("inbox.jsonl", e);
	const cycle: CycleLogEntry = {
		type: "cycle", cycleId: "cyc_1", trigger: "schedule", startedAt: "2026-11-03T13:00:00.000Z", endedAt: "2026-11-03T13:30:00.000Z",
		stoppedBy: "completed",
		gaps: [{
			gapId: "gap_1", type: "unverified", nodeId: N.a, questions: ["q1"], confidence: 0.9, rationale: HIDDEN.rationale, stoppedBy: "confidence",
			sources: [{ locator: HIDDEN.locator, outcome: "inbox", nodesAdded: 0 }], nodesAdded: 2, costUsd: 0.2, saturated: false, error: HIDDEN.researchError,
		}],
		watch: { entries: 1, items: 3, ingested: 1, inbox: 2 }, nodesAdded: 2, costUsd: 0.25, steers: [HIDDEN.steer],
	};
	f.ext("research-log.jsonl", cycle);
}
