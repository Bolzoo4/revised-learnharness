/**
 * Typed links from the extraction pipeline (REQ-graph-agent-07 and 04): the
 * EXTRACTOR proposes typed links between nodes of its own run; the links
 * store persists them with origin "extractor"; the AUDITOR never writes a
 * link; and when nodes merge, stored links follow the survivor ids.
 *
 * Ledgers are in-memory (the GraphStore port and an in-memory link ledger):
 * this suite never touches data/graph or data/ext.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { AuditVerdicts, CoverageEntry, GraphChain, GraphNode, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { mergeFindings } from "../src/core/graph.ts";
import type { LinkEvent } from "../src/core/ext/links.ts";
import { createLinksStore } from "../src/server/ext/links-store.ts";
import type { Ledger } from "../src/store/ext/ledger.ts";
import { chatStore } from "../src/store/chats.ts";
import * as fs from "node:fs";
import { PATHS } from "../config.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const createdChats: string[] = [];
const AT = "2026-11-22T10:00:00.000Z";

/** A scripted pi engine (faux provider): the response queue drives one agent. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** An engine whose ONE response is the named tool call with the given input. */
function submitModel(name: string, input: unknown): PiEngine {
	return fauxEngine([
		() => fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })], { stopReason: "toolUse" }),
	]);
}

/** An in-memory GraphStore (core/ports.ts) — the same shape the pipeline suite uses. */
function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const positions = new Map<string, { x: number; y: number }>();
	return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e: CoverageEntry) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		deleteSources: (ids: ReadonlySet<string>) => [...ids].reduce((count, id) => count + Number(sources.delete(id)), 0),
		appendSourceUsage: () => undefined,
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next: Record<string, { x: number; y: number }>) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[]; coverage?: CoverageEntry[]; checkpoints?: SessionCheckpoint[] }) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
	} satisfies GraphStore;
}

/** An in-memory link ledger: the same append/readAll port the JSONL ledger implements. */
function memoryLinkLedger(): Ledger<LinkEvent> {
	const events: LinkEvent[] = [];
	return {
		append: (event: LinkEvent) => void events.push(event),
		readAll: () => [...events],
	};
}

/** A links store over the memory ledger, with deterministic ids and clock. */
function linksFixture() {
	const ledger = memoryLinkLedger();
	let n = 0;
	const store = createLinksStore(ledger, { newId: () => `link_${++n}`, now: () => AT });
	return { store, ledger };
}

const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: Date.now() }) as never;

const teacher = (id: string, text: string): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;

/** A two-passage session: a1 (chain rule prose) and a2 (derivative prose), each a teacher message. */
function fixtureChat(): { chatId: string } {
	const chat = chatStore.createChat("Extraction links fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		teacher("a1", "The chain rule composes rates of change along a path."),
		user("u2", "go on"),
		teacher("a2", "The derivative measures how fast a function changes."),
	]);
	return { chatId: chat.id };
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
			/* already gone */
		}
	}
});

/** Two propositions and one chain, the same shape the pipeline suite uses. */
const FINDINGS = {
	propositions: [
		{ id: "p1", name: "Derivative", statement: "The derivative measures how fast a function changes", aliases: [], messageId: "a2" },
		{ id: "p2", name: "Chain rule", statement: "The chain rule differentiates composed functions by multiplying local rates.", aliases: [], messageId: "a1" },
	],
	chains: [{ premises: ["p1"], conclusion: "p2" }],
};

const EMPTY_AUDIT = { links: [] };

/** The node id a merged run created for a proposition name. */
function idNamed(ledgers: ReturnType<typeof memoryLedgers>, name: string): string {
	const node = ledgers.readNodes().find((n) => n.name === name);
	assert.ok(node, `a node named ${name} exists`);
	return node.id;
}

// ─── the extractor proposes; the store persists with origin "extractor" ─────

describe("extractor-proposed links (REQ-graph-agent-07)", () => {
	it("a valid link between two nodes of the same run is stored with origin extractor", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const { store } = linksFixture();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			linksStore: store,
			extractor: submitModel("submit_findings", { ...FINDINGS, links: [{ from: "p1", to: "p2", linkType: "evolution" }] }),
			auditor: submitModel("submit_review", EMPTY_AUDIT),
		});
		await pipeline.runExtraction(chatId);

		const links = store.readLinks();
		assert.equal(links.length, 1);
		assert.equal(links[0]!.from, idNamed(ledgers, "Derivative"));
		assert.equal(links[0]!.to, idNamed(ledgers, "Chain rule"));
		assert.equal(links[0]!.linkType, "evolution");
		assert.equal(links[0]!.origin, "extractor");
	});

	it("a link naming a node the run did not create and the graph does not know is dropped without throwing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const { store } = linksFixture();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			linksStore: store,
			extractor: submitModel("submit_findings", { ...FINDINGS, links: [{ from: "p1", to: "n_ghost", linkType: "sequence" }] }),
			auditor: submitModel("submit_review", EMPTY_AUDIT),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.deepEqual(stats, { nodes: 2, chains: 1 }, "the merge still completes");
		assert.deepEqual(store.readLinks(), []);
	});

	it("a link with an unknown linkType is dropped without throwing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const { store } = linksFixture();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			linksStore: store,
			extractor: submitModel("submit_findings", { ...FINDINGS, links: [{ from: "p1", to: "p2", linkType: "bogus" }] }),
			auditor: submitModel("submit_review", EMPTY_AUDIT),
		});
		await pipeline.runExtraction(chatId);

		assert.deepEqual(store.readLinks(), []);
	});

	it("the auditor never becomes a link, even when its JSON carries link-shaped fields", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const { store } = linksFixture();
		const existingId = "n_auditor_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const verdicts = {
			links: [{ id: "p1", linkTo: existingId, from: existingId, to: "p2", linkType: "evolution" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			linksStore: store,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdicts),
		});
		await pipeline.runExtraction(chatId);

		assert.deepEqual(store.readLinks(), [], "no typed link comes from the auditor");
	});
});

// ─── the merger remaps stored links when nodes merge ───────────────────────

describe("links follow merged node ids (REQ-graph-agent-04)", () => {
	it("a link to a merged-away id moves to the survivor, and a link that becomes a self-link is removed", () => {
		const ledgers = memoryLedgers();
		const { store } = linksFixture();
		for (const id of ["n_keep", "n_gone", "n_other"]) {
			ledgers.appendNode({ id, name: id, statement: id, aliases: [], createdAt: AT, provenance: [] });
		}
		store.appendLink({ from: "n_gone", to: "n_other", linkType: "evolution", origin: "user" }, new Set(["n_keep", "n_gone", "n_other"]));
		store.appendLink({ from: "n_keep", to: "n_gone", linkType: "sequence", origin: "agent" }, new Set(["n_keep", "n_gone", "n_other"]));

		mergeFindings(
			"chat_remap",
			{ propositions: [], chains: [] },
			{ links: [] } as AuditVerdicts,
			{ chatStore, graphStore: ledgers },
			{ foldedAt: AT },
			{ store, mergedIntoId: new Map([["n_gone", "n_keep"]]) },
		);

		const links = store.readLinks();
		assert.equal(links.length, 1, "the self-link is gone");
		assert.equal(links[0]!.from, "n_keep");
		assert.equal(links[0]!.to, "n_other");
		assert.equal(links[0]!.linkType, "evolution");
		assert.equal(links[0]!.origin, "user", "the remapped link keeps its origin");
	});
});
