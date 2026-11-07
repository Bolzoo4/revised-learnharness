/**
 * The shared visual job tools for the extension sessions (demo, visual, video):
 *   - the helper's registry: demo + visual always, video only with a runtime,
 *     never research or pdf, and the user toggles drop what they switch off
 *   - dispatch is the teacher's: one job per toolCallId, spawned once
 *   - the instruction paragraph is editable (catalog id visual-jobs) and rides
 *     only when a job tool is offered
 *   - the review and study agents carry the tools only when given the job
 *     wiring, and the toggles apply to them
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { JobRecord } from "../src/core/contracts.ts";
import type { JobStore } from "../src/core/ports.ts";
import { EXT_PROMPT_IDS } from "../src/core/ext/prompt-catalog.ts";
import { extPromptDefault } from "../src/agent/ext/prompt-defaults.ts";
import { visualJobTools, visualJobInstructions, withVisualJobInstructions, type VisualJobDeps } from "../src/agent/ext/visual-job-tools.ts";
import { createReviewAgent } from "../src/agent/ext/review-agent.ts";
import type { ReviewToolContext } from "../src/agent/ext/review-tools.ts";
import { createStudyAgent } from "../src/agent/ext/study/study-agent.ts";
import type { StudyToolContext } from "../src/agent/ext/study/study-tools.ts";

/** A runtime directory that only has to exist with bin/manim and bin/ffprobe (the tools never run them). */
const FAKE_RUNTIME = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-visual-jobs-rt-"));
	fs.mkdirSync(path.join(dir, "bin"));
	fs.writeFileSync(path.join(dir, "bin", "manim"), "#!/bin/sh\n");
	fs.writeFileSync(path.join(dir, "bin", "ffprobe"), "#!/bin/sh\n");
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
})();

/** An in-memory job store: only the two methods the dispatch path uses. */
function memoryJobs(): JobStore & { jobs: JobRecord[] } {
	const jobs: JobRecord[] = [];
	return {
		jobs,
		createJob(init: { kind: JobRecord["kind"]; chatId: string; toolCallId: string; input?: unknown }) {
			const job = { id: `job_${jobs.length + 1}`, kind: init.kind, chatId: init.chatId, toolCallId: init.toolCallId, input: init.input, status: "running", activity: "starting" } as JobRecord;
			jobs.push(job);
			return job;
		},
		findJobByToolCallId(chatId: string, toolCallId: string) {
			return jobs.find((j) => j.chatId === chatId && j.toolCallId === toolCallId);
		},
	} as unknown as JobStore & { jobs: JobRecord[] };
}

function depsWith(spawned: JobRecord[] = []): VisualJobDeps & { jobs: JobRecord[] } {
	const jobStore = memoryJobs();
	return { chatId: "c1", jobStore, spawn: (job) => spawned.push(job), jobs: jobStore.jobs };
}

const FAKE_ENGINE = {
	model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192 },
	streamFn: (async () => {
		throw new Error("not streamed in this test");
	}) as never,
} as never;

const names = (tools: Record<string, unknown>): string[] => Object.keys(tools).sort();

describe("visual job tools: the registry", () => {
	it("offers demo and visual, and video only when a runtime exists", () => {
		assert.deepEqual(names(visualJobTools(depsWith(), undefined, null)), ["demo", "visual"]);
		assert.deepEqual(names(visualJobTools(depsWith(), undefined, FAKE_RUNTIME)), ["demo", "video", "visual"]);
	});

	it("never carries research or pdf (those stay the teacher's and the practice's)", () => {
		const all = names(visualJobTools(depsWith(), undefined, FAKE_RUNTIME));
		assert.ok(!all.includes("research") && !all.includes("pdf"));
	});

	it("drops a tool the user switched off, the same filter as the teacher's", () => {
		assert.deepEqual(names(visualJobTools(depsWith(), { demo: false, video: false }, FAKE_RUNTIME)), ["visual"]);
		assert.deepEqual(names(visualJobTools(depsWith(), { visual: false }, null)), ["demo"]);
		// an explicit true (or an absent key) keeps the tool
		assert.deepEqual(names(visualJobTools(depsWith(), { demo: true }, null)), ["demo", "visual"]);
	});
});

describe("visual job tools: dispatch", () => {
	it("creates one demo job per toolCallId and spawns it once", async () => {
		const deps = depsWith();
		const tool = visualJobTools(deps, undefined, null).demo!;
		const first = await tool.execute("tc1", { title: "Oscillator", brief: "A damped oscillator with a damping slider." } as never, undefined as never);
		const again = await tool.execute("tc1", { title: "Oscillator", brief: "A damped oscillator with a damping slider." } as never, undefined as never);
		assert.equal(deps.jobs.length, 1);
		assert.equal(deps.jobs[0]!.kind, "demo");
		assert.equal(deps.jobs[0]!.chatId, "c1");
		assert.match(JSON.stringify(first), /Dispatched \(job job_1\)/);
		assert.match(JSON.stringify(again), /Dispatched \(job job_1\)/);
	});

	it("dispatches a visual job with its brief", async () => {
		const deps = depsWith();
		const tool = visualJobTools(deps, undefined, null).visual!;
		await tool.execute("tc2", { brief: "Vectors from the origin to (2,1) and (-1,3)." } as never, undefined as never);
		assert.equal(deps.jobs[0]!.kind, "visual");
	});
});

describe("visual job tools: the instruction paragraph", () => {
	it("is an editable catalog prompt whose default names the three tools", () => {
		assert.ok((EXT_PROMPT_IDS as readonly string[]).includes("visual-jobs"));
		const text = extPromptDefault("visual-jobs");
		for (const name of ["demo", "visual", "video"]) assert.match(text, new RegExp(`\`${name}\``), name);
		assert.match(text, /when it is among your tools/);
	});

	it("rides only when at least one job tool is offered", () => {
		assert.equal(withVisualJobInstructions("BASE", {}), "BASE");
		const added = withVisualJobInstructions("BASE", visualJobTools(depsWith(), undefined, null));
		assert.ok(added.startsWith("BASE\n\n"));
		assert.equal(added, `BASE\n\n${visualJobInstructions()}`);
	});
});

describe("ext agents carry the visual job tools", () => {
	const reviewCtx = {
		chatId: "c1",
		chatStore: { getChat: () => ({ messages: [], kind: "review" }) },
		nextItem: () => ({ kind: "none" }),
		record: () => ({ dueAt: "", credited: [], penalised: [] }),
	} as unknown as ReviewToolContext;

	it("review: demo and visual when given the job wiring, toggles honoured, prompt carries the paragraph", () => {
		const agent = createReviewAgent(reviewCtx, { engine: FAKE_ENGINE, toolToggles: { video: false } }, depsWith());
		const toolNames = agent.state.tools.map((t) => t.name);
		assert.ok(toolNames.includes("demo") && toolNames.includes("visual"));
		assert.ok(!toolNames.includes("video"));
		assert.ok(toolNames.includes("next_item"));
		assert.match(agent.state.systemPrompt, /Demos, figures and videos/);
	});

	it("review: no job tools and no paragraph without the job wiring (the test seam)", () => {
		const agent = createReviewAgent(reviewCtx, { engine: FAKE_ENGINE });
		const toolNames = agent.state.tools.map((t) => t.name);
		assert.ok(!toolNames.includes("demo") && !toolNames.includes("visual"));
		assert.doesNotMatch(agent.state.systemPrompt, /Demos, figures and videos/);
	});

	it("study: the job tools ride the study agent too", () => {
		const studyCtx = {
			chatId: "c1",
			chatStore: { getChat: () => ({ messages: [] }) },
			document: () => null,
			pageText: () => null,
			search: () => [],
		} as unknown as StudyToolContext;
		const agent = createStudyAgent(studyCtx, { engine: FAKE_ENGINE }, depsWith());
		const toolNames = agent.state.tools.map((t) => t.name);
		assert.ok(toolNames.includes("demo") && toolNames.includes("visual"));
	});
});
