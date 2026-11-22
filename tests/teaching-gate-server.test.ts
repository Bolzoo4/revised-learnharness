/**
 * The teaching gate at the chat-handler seam (REQ-graph-agent-19/20/21), with
 * scripted faux models and fake extraction runs. The 60 s cap is shortened
 * through the server seam's timing setter; the core timer is pinned separately.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { extractorInputOf } from "../src/agent/subagents/extraction.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { newPlanBlockMessage, type LhMessage } from "../src/core/native-messages.ts";
import { coverageOf } from "../src/core/coverage.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { clearNotExtracted as trackClear } from "../src/server/teaching-gate.ts";
import {
	forceExtractionFor,
	markNotExtracted,
	notExtractedIds,
	setTeachingGateTiming,
	trackExtraction,
} from "../src/server/teaching-gate.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { PATHS } from "../config.ts";
import * as os from "node:os";
import { startExtractionIfDue } from "../src/server/turn-service.ts";
import type { ExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { graphStore as liveGraphStore } from "../src/store/graph.ts";
import { makeTeachingGateLedger, planInProgress, setTeachingGateLedger } from "../src/server/teaching-gate.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

/** A scripted teacher: each response step is one model call. */
function scriptedTeacher(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function textTurn(text: string): FauxResponseStep {
	return () => fauxAssistantMessage([fauxText(text)]);
}

/** The factory seam: counts model-call construction and records the moment. */
function countingFactory(engine: PiEngine, onCall: () => void): Parameters<typeof handleChatRequest>[1] {
	return (opts) => {
		onCall();
		return createTeacherAgent(undefined, { engine, messages: opts.messages });
	};
}

function post(chatId: string, text: string): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text } }),
	});
}

function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

/** Run one turn to completion; the factory counts the model constructions. */
async function runTurn(chatId: string, text: string, engine: PiEngine, onCall: () => void = () => {}): Promise<void> {
	const ack = await handleChatRequest(post(chatId, text), countingFactory(engine, onCall));
	assert.equal(ack.status, 200);
	await waitFor(() => !isTurnRunning(chatId), 8000, "turn settle");
}

const createdChats: string[] = [];
const tmpLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-gate-"));
setTeachingGateLedger(makeTeachingGateLedger(tmpLedgerDir));
after(() => {
	setTeachingGateTiming(null);
	setTeachingGateLedger(null);
	fs.rmSync(tmpLedgerDir, { recursive: true, force: true });
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

describe("teaching gate at the chat-handler seam (REQ-graph-agent-19/20)", () => {
	it("a pending extraction holds the model call until it settles", async () => {
		const chat = createConfiguredChat("Test: gate waits");
		createdChats.push(chat.id);
		await runTurn(chat.id, "teach me the planets", scriptedTeacher([textTurn("Seed prose.")]));

		let resolveRun!: (v: unknown) => void;
		const run = new Promise((r) => (resolveRun = r));
		let runSettled = false;
		void run.then(() => (runSettled = true));
		trackExtraction(chat.id, run);

		let modelCalls = 0;
		let settledAtModelCall: boolean | null = null;
		const ackP = handleChatRequest(
			post(chat.id, "next step please"),
			(opts) => {
				modelCalls++;
				settledAtModelCall = runSettled;
				return createTeacherAgent(undefined, { engine: scriptedTeacher([textTurn("Next step.")]), messages: opts.messages });
			},
		);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(modelCalls, 0, "the model is not called while the extraction is in flight");

		resolveRun({ nodes: 1, chains: 0 });
		assert.equal((await ackP).status, 200);
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle after the gate");
		assert.equal(modelCalls, 1, "the model is called once the extraction settled");
		assert.equal(settledAtModelCall, true, "the model call came after the extraction settled");
	});

	it("on timeout the model call proceeds and the previous turn is marked not-extracted", async () => {
		const chat = createConfiguredChat("Test: gate times out");
		createdChats.push(chat.id);
		await runTurn(chat.id, "teach me the planets", scriptedTeacher([textTurn("Seed prose.")]));
		const seedId = chatStore.getChat(chat.id)!.messages.find((m) => m.role === "assistant")!.id;

		setTeachingGateTiming({ timeoutMs: 20, timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) } });
		trackExtraction(chat.id, new Promise(() => {}));

		let modelCalls = 0;
		await runTurn(chat.id, "and the next step", scriptedTeacher([textTurn("Next step.")]), () => modelCalls++);

		assert.equal(modelCalls, 1, "the teaching turn proceeds after the cap");
		const texts = chatStore.getChat(chat.id)!.messages.map((m) => JSON.stringify(m.content));
		assert.ok(texts.some((t) => t.includes("Next step.")), "the teacher's reply is persisted");
		assert.ok(notExtractedIds(chat.id).has(seedId), "the un-extracted previous turn carries the not-extracted marker");
		assert.equal(forceExtractionFor(chat.id), true, "the next extraction is forced to catch the marked turn up");
	});

	it("a failed extraction also lets the teacher continue and marks the turn", async () => {
		const chat = createConfiguredChat("Test: gate failure");
		createdChats.push(chat.id);
		await runTurn(chat.id, "teach me the planets", scriptedTeacher([textTurn("Seed prose.")]));

		const failing = Promise.reject(new Error("extractor down"));
		failing.catch(() => {});
		trackExtraction(chat.id, failing);

		let modelCalls = 0;
		await runTurn(chat.id, "and the next step", scriptedTeacher([textTurn("Next step.")]), () => modelCalls++);
		assert.equal(modelCalls, 1);
		assert.equal(notExtractedIds(chat.id).size > 0, true);
	});

	it("the next extraction input includes the marked turn's prose, with its message id", () => {
		const chat = createConfiguredChat("Test: catch-up input");
		createdChats.push(chat.id);
		const messages = [
			{ id: "a-seed", role: "assistant", content: [{ type: "text", text: "The chain rule composes rates." }] },
		] as unknown as LhMessage[];
		chatStore.saveMessages(chat.id, messages);
		markNotExtracted(chat.id, ["a-seed"]);
		const record = chatStore.getChat(chat.id)!;
		const uncovered = coverageOf(record.messages, graphStore.readCoverage(), chat.id).uncovered;
		assert.equal(uncovered.length, 1, "the marked turn is uncovered, so the next run batches it");
		const input = extractorInputOf(record.messages, record.title);
		assert.ok(input, "the marked prose yields extractor input");
		assert.match(input!.view, /^TEACHER \[a-seed\] The chain rule composes rates\.$/m);
	});
});

describe("extractor input builder keeps teacher prose only (REQ-graph-agent-21)", () => {
	it("a message whose only content is a plan block or tool calls yields no extractor input", () => {
		const planBlock = newPlanBlockMessage("call-plan", {
			kind: "full",
			at: "2026-01-01T00:00:00.000Z",
			current: null,
			nodes: [{ id: "n1", title: "Planet order", status: "upcoming" }],
			edges: [],
		});
		const toolOnly = {
			id: "a-tool",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-q", name: "quiz", arguments: { question: "Which planet?" } }],
		} as unknown as LhMessage;
		const planCall = {
			id: "a-plan",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-p", name: "plan_init", arguments: { title: "Goal title" } }],
		} as unknown as LhMessage;
		assert.equal(extractorInputOf([planBlock, toolOnly, planCall], "Goal title"), null, "no teacher prose, no extractor input");
	});

	it("a plan block and tool inputs beside prose never reach the extractor", () => {
		const planBlock = newPlanBlockMessage("call-plan", {
			kind: "full",
			at: "2026-01-01T00:00:00.000Z",
			current: null,
			nodes: [{ id: "n1", title: "Secret plan step", status: "upcoming" }],
			edges: [],
		});
		const mixed = {
			id: "a-mixed",
			role: "assistant",
			content: [
				{ type: "text", text: "Only this is prose." },
				{ type: "toolCall", id: "call-q", name: "quiz", arguments: { question: "Tool input must not leak" } },
			],
		} as unknown as LhMessage;
		const input = extractorInputOf([planBlock, mixed], "Goal title");
		assert.ok(input);
		assert.match(input!.view, /TEACHER \[a-mixed\] Only this is prose\./);
		assert.doesNotMatch(input!.view, /Secret plan step/);
		assert.doesNotMatch(input!.view, /Tool input must not leak/);
	});
});

/** A fake extraction pipeline: records the chats it was asked to extract. */
function fakeExtraction(run: Promise<unknown>): { pipeline: ExtractionPipeline; calls: string[] } {
	const calls: string[] = [];
	const pipeline = { runExtraction: (chatId: string) => (calls.push(chatId), run) } as unknown as ExtractionPipeline;
	return { pipeline, calls };
}

describe("extraction after every plan turn (REQ-graph-agent-19)", () => {
	it("a plan in progress starts extraction after a short turn below the budget, and the next turn waits for it", async () => {
		setTeachingGateTiming(null); // the real 60 s cap: an earlier test shortened it
		const chat = createConfiguredChat("Test: plan forces extraction");
		createdChats.push(chat.id);
		await runTurn(chat.id, "teach me the planets", scriptedTeacher([textTurn("Short.")]));

		let resolveRun!: (v: unknown) => void;
		const fake = fakeExtraction(new Promise((r) => (resolveRun = r)));
		const started = startExtractionIfDue({ chatStore, graphStore: liveGraphStore }, fake.pipeline, chat.id, 1_000_000);
		assert.ok(started, "a plan in progress starts a run even far below the chunk budget");
		assert.deepEqual(fake.calls, [chat.id]);

		let modelCalls = 0;
		const ackP = handleChatRequest(post(chat.id, "next step"), countingFactory(scriptedTeacher([textTurn("Next.")]), () => modelCalls++));
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(modelCalls, 0, "the next user turn waits for the previous turn's extraction");
		resolveRun({ nodes: 0, chains: 0 });
		assert.equal((await ackP).status, 200);
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle");
		assert.equal(modelCalls, 1);
	});

	it("without a plan a short turn below the budget starts no run (regression)", async () => {
		const chat = chatStore.createChat("Test: no plan, no forced run");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		await runTurn(chat.id, "just chatting", scriptedTeacher([textTurn("Short.")]));

		const fake = fakeExtraction(Promise.resolve({ nodes: 0, chains: 0 }));
		const started = startExtractionIfDue({ chatStore, graphStore: liveGraphStore }, fake.pipeline, chat.id, 1_000_000);
		assert.equal(started, null);
		assert.deepEqual(fake.calls, []);
	});

	it("a finished plan (every node visited) no longer forces a run", () => {
		const chat = createConfiguredChat("Test: finished plan");
		createdChats.push(chat.id);
		const messages = [
			{ id: "a-quiz", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "quiz", arguments: { nodeId: "planet-order" } }] },
		] as unknown as LhMessage[];
		chatStore.saveMessages(chat.id, messages);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(planInProgress(record), false, "the only node was quizzed: the plan is finished");
	});

	it("a plan with unvisited nodes is in progress", () => {
		const chat = createConfiguredChat("Test: unfinished plan");
		createdChats.push(chat.id);
		assert.equal(planInProgress(chatStore.getChat(chat.id)!), true, "a plan with no quiz yet is not finished");
	});

	it("the not-extracted marker survives a restart (durable ledger)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-gate-restart-"));
		try {
			setTeachingGateLedger(makeTeachingGateLedger(dir));
			markNotExtracted("chat-durable", ["a-1", "a-2"]);
			setTeachingGateLedger(makeTeachingGateLedger(dir)); // a fresh process reads the ledger
			assert.deepEqual([...notExtractedIds("chat-durable")].sort(), ["a-1", "a-2"]);
			setTeachingGateLedger(makeTeachingGateLedger(dir));
			trackClear("chat-durable");
			setTeachingGateLedger(makeTeachingGateLedger(dir));
			assert.equal(notExtractedIds("chat-durable").size, 0, "a successful run clears the marker durably");
		} finally {
			setTeachingGateLedger(makeTeachingGateLedger(tmpLedgerDir));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
