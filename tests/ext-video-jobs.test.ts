/**
 * The video job path, with fakes for the model and the renderer (REQ-vid-04,
 * 08, 09, 11, 12, 13):
 *   - the tool: offered only when the runtime exists; validates its input
 *     (no job for a bad input); dispatch is fire-and-forget and deduped by
 *     toolCallId; the teacher registry carries it, and the settings toggle
 *     can switch it off
 *   - the runner: success delivers a steer with the video result; a failed
 *     render delivers the failure shape with the demo fallback; no renderer
 *     refuses honestly
 *   - the steer and failure contract (pure) and the job store's removal of
 *     the mp4 with the job (deleteJobsForChat)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { videoJobTools, videoInputSchema } from "../src/agent/ext/video-tools.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { createJobRunner, demoModelOverride } from "../src/agent/subagents/runner.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { buildSubagentSteer, isSubagentFailure, type JobRecord, type SteerMessage, type VideoResult } from "../src/core/contracts.ts";
import type { VideoRenderOutcome } from "../src/core/ext/video/outcome.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { jobVideoPath } from "../src/store/ext/job-video.ts";
import { videoResponse } from "../src/server/ext/video-serve.ts";
import type { JobStore } from "../src/core/ports.ts";

const GOOD = "from manim import *\nclass Scene(Scene):\n    def construct(self):\n        self.wait(1)\n";
/** A runtime directory that only has to exist with bin/manim and bin/ffprobe (the tool never runs them). */
const FAKE_RUNTIME = (() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-video-jobs-rt-"));
	fs.mkdirSync(path.join(dir, "bin"));
	fs.writeFileSync(path.join(dir, "bin", "manim"), "#!/bin/sh\n");
	fs.writeFileSync(path.join(dir, "bin", "ffprobe"), "#!/bin/sh\n");
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
})();

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

/** An in-memory JobStore for the tool test (no files). */
function memoryJobs(): JobStore & { jobs: JobRecord[] } {
	const jobs: JobRecord[] = [];
	return {
		jobs,
		createJob(init) {
			const job: JobRecord = {
				id: `job_${jobs.length + 1}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				...(init.input !== undefined ? { input: init.input } : {}),
				status: "running",
				activity: init.activity ?? "starting",
				createdAt: "2026-11-07T10:00:00.000Z",
				updatedAt: "2026-11-07T10:00:00.000Z",
			};
			jobs.push(job);
			return job;
		},
		getJob: (id) => jobs.find((j) => j.id === id) ?? null,
		updateJob(id, patch) {
			const i = jobs.findIndex((j) => j.id === id);
			if (i < 0) return null;
			jobs[i] = { ...jobs[i]!, ...patch };
			return jobs[i]!;
		},
		listJobs: (chatId) => jobs.filter((j) => j.chatId === chatId),
		findJobByToolCallId: (chatId, toolCallId) => jobs.find((j) => j.chatId === chatId && j.toolCallId === toolCallId) ?? null,
		deleteJobsForChat: () => 0,
	} as JobStore & { jobs: JobRecord[] };
}

describe("video tool (REQ-vid-04, REQ-vid-12)", () => {
	it("is not offered when no runtime is installed", () => {
		assert.deepEqual(videoJobTools({ chatId: "c", jobStore: memoryJobs(), spawn: () => {} }, null), {});
	});

	it("is offered as `video` when a runtime exists, with the title and brief schema", () => {
		const tools = videoJobTools({ chatId: "c", jobStore: memoryJobs(), spawn: () => {} }, FAKE_RUNTIME);
		assert.deepEqual(Object.keys(tools), ["video"]);
		assert.ok(videoInputSchema);
	});

	it("rejects bad input with a message and creates no job", async () => {
		const store = memoryJobs();
		const spawned: JobRecord[] = [];
		const tool = videoJobTools({ chatId: "c", jobStore: store, spawn: (job) => spawned.push(job) }, FAKE_RUNTIME).video!;
		const result = await tool.execute("tc1", { title: " ", brief: "" }, undefined as never);
		assert.match(textOf(result as never), /ERROR/);
		assert.equal(store.jobs.length, 0);
		assert.equal(spawned.length, 0);
	});

	it("dispatches a video job fire-and-forget and dedupes by toolCallId", async () => {
		const store = memoryJobs();
		const spawned: JobRecord[] = [];
		const tool = videoJobTools({ chatId: "c", jobStore: store, spawn: (job) => spawned.push(job) }, FAKE_RUNTIME).video!;
		const input = { title: "Circle", brief: "Draw a circle." };
		const first = await tool.execute("tc2", input, undefined as never);
		const again = await tool.execute("tc2", input, undefined as never);
		assert.match(textOf(first as never), /fire-and-forget/);
		assert.match(textOf(again as never), /Dispatched/);
		assert.equal(store.jobs.length, 1);
		assert.equal(store.jobs[0]!.kind, "video");
		assert.equal(spawned.length, 1);
	});

	it("the teacher registry carries video when a runtime exists, and the settings toggle removes it", () => {
		const common = { chatId: "c", chatStore, jobStore: memoryJobs(), spawn: () => {} } as never;
		const prev = process.env.LH_MANIM_RUNTIME;
		process.env.LH_MANIM_RUNTIME = FAKE_RUNTIME;
		try {
			assert.ok(createTeacherTools(common)["video"], "offered when the runtime exists");
			assert.equal(createTeacherTools(common, { video: false })["video"], undefined, "switched off in settings");
		} finally {
			if (prev === undefined) delete process.env.LH_MANIM_RUNTIME;
			else process.env.LH_MANIM_RUNTIME = prev;
		}
	});
});

function scripted(turns: Array<{ tool?: { id: string; name: string; input: unknown }; text?: string }>): PiEngine {
	const steps: FauxResponseStep[] = turns.map((t) =>
		t.tool
			? fauxAssistantMessage([fauxToolCall(t.tool.name, t.tool.input as ToolCall["arguments"], { id: t.tool.id })], { stopReason: "toolUse" })
			: fauxAssistantMessage(t.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A chat-less runner rig: memory jobs, the real chat store only for getChat (empty). */
function rig(render: ((args: { jobId: string; scene: string; signal: AbortSignal }) => Promise<VideoRenderOutcome>) | undefined) {
	const store = memoryJobs();
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({
		chatStore: { getChat: () => ({ id: "c", messages: [] }) } as never,
		jobStore: store,
		deliver: async (steer) => {
			steers.push(steer);
		},
		...(render ? { videoRender: render } : {}),
	});
	return { store, steers, runner };
}

function dispatch(store: JobStore & { jobs: JobRecord[] }, input: { title: string; brief: string }): JobRecord {
	return store.createJob({ kind: "video", chatId: "c", toolCallId: `tc_${store.jobs.length}`, input });
}

after(() => {
	demoModelOverride.current = undefined;
});

describe("video runner (REQ-vid-07, REQ-vid-08)", () => {
	it("a passing render delivers a video steer carrying the job id and the scene", async () => {
		const { store, steers, runner } = rig(async () => ({ ok: true, durationSec: 1.5 }));
		demoModelOverride.current = scripted([
			{ tool: { id: "w", name: "write_scene", input: { scene: GOOD } } },
			{ tool: { id: "r", name: "render_video", input: {} } },
			{ text: "A waiting scene." },
		]);
		const job = dispatch(store, { title: "Wait", brief: "A wait." });
		await runner.runJob(job.id, { title: "Wait", brief: "A wait." });
		assert.equal(steers.length, 1);
		const steer = steers[0]!;
		assert.equal(steer.customType, "subagent-steer");
		const result = (steer.details as { result: VideoResult }).result;
		assert.equal(result.jobId, job.id);
		assert.equal(result.scene, GOOD);
		assert.equal(result.durationSec, 1.5);
		assert.equal(isSubagentFailure("video", result as never), false);
		assert.equal(store.getJob(job.id)!.status, "done");
	});

	it("a failed render delivers the failure shape with the demo fallback and the job lands in error", async () => {
		const { store, steers, runner } = rig(async () => ({ ok: false, reason: "denied", detail: "Operation not permitted" }));
		demoModelOverride.current = scripted([
			{ tool: { id: "w", name: "write_scene", input: { scene: GOOD } } },
			{ tool: { id: "r1", name: "render_video", input: {} } },
			{ tool: { id: "r2", name: "render_video", input: {} } },
			{ tool: { id: "r3", name: "render_video", input: {} } },
			{ tool: { id: "r4", name: "render_video", input: {} } },
			{ tool: { id: "r5", name: "render_video", input: {} } },
			{ text: "No video." },
		]);
		const job = dispatch(store, { title: "Denied", brief: "b" });
		await runner.runJob(job.id, { title: "Denied", brief: "b" });
		const steer = steers[0]!;
		const result = (steer.details as { result: VideoResult }).result;
		assert.equal(result.jobId, "");
		assert.equal(isSubagentFailure("video", result as never), true);
		assert.match(steer.content, /could not be made/);
		assert.match(steer.content, /demo/);
		assert.equal(store.getJob(job.id)!.status, "error");
	});

	it("without a renderer the job refuses honestly with a failure steer", async () => {
		const { store, steers, runner } = rig(undefined);
		const job = dispatch(store, { title: "NoRenderer", brief: "b" });
		await runner.runJob(job.id, { title: "NoRenderer", brief: "b" });
		assert.equal(steers.length, 1);
		assert.equal(store.getJob(job.id)!.status, "error");
		assert.match(steers[0]!.content, /demo/);
	});
});

describe("video steer contract (pure)", () => {
	it("a success steer tells the teacher to teach with the video; a failure steer names the demo fallback", () => {
		const ok = buildSubagentSteer({ id: "job_1", kind: "video", toolCallId: "t" }, { title: "T", jobId: "job_1", scene: GOOD, durationSec: 2 } as never);
		assert.match(ok.content, /rendered/);
		const bad = buildSubagentSteer({ id: "job_2", kind: "video", toolCallId: "t" }, { title: "T", jobId: "", scene: "", durationSec: 0, notes: "FAILED: x" } as never);
		assert.match(bad.content, /could not be made/);
		assert.match(bad.content, /demo/);
	});
});

describe("the mp4 lives with the job (REQ-vid-13)", () => {
	it("deleting a chat's jobs removes their video files", () => {
		const chatId = `chat_video_${Date.now().toString(36)}`;
		const job = jobStore.createJob({ kind: "video", chatId, toolCallId: "tc_del", input: { title: "x", brief: "y" } });
		try {
			const file = jobVideoPath(job.id);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "mp4-bytes");
			assert.equal(fs.existsSync(file), true);
			jobStore.deleteJobsForChat(chatId);
			assert.equal(fs.existsSync(file), false);
		} finally {
			try {
				fs.unlinkSync(jobVideoPath(job.id));
			} catch {
				/* already gone */
			}
		}
	});
});

describe("the video route's response (REQ-vid-10, REQ-vid-13)", () => {
	const id = "job_serve_test";
	const record = (over: Partial<JobRecord>): JobRecord => ({
		id,
		kind: "video",
		chatId: "c",
		toolCallId: "tc",
		status: "done",
		activity: "finished",
		createdAt: "2026-11-07T10:00:00.000Z",
		updatedAt: "2026-11-07T10:00:00.000Z",
		...over,
	});
	after(() => {
		try {
			fs.unlinkSync(jobVideoPath(id));
		} catch {
			/* not written */
		}
	});

	it("serves a finished video job's file, with Range support, and 404s everything else", async () => {
		fs.mkdirSync(path.dirname(jobVideoPath(id)), { recursive: true });
		fs.writeFileSync(jobVideoPath(id), Buffer.from("0123456789"));
		const full = videoResponse(record({}), id, null);
		assert.equal(full.status, 200);
		assert.equal(full.headers.get("content-type"), "video/mp4");
		assert.equal(Buffer.from(await full.arrayBuffer()).toString(), "0123456789");
		const part = videoResponse(record({}), id, "bytes=2-4");
		assert.equal(part.status, 206);
		assert.equal(Buffer.from(await part.arrayBuffer()).toString(), "234");
		assert.equal(videoResponse(record({ kind: "demo" }), id, null).status, 404);
		assert.equal(videoResponse(record({ status: "running" }), id, null).status, 404);
		assert.equal(videoResponse(null, id, null).status, 404);
		assert.equal(videoResponse(record({}), "../escape", null).status, 404);
	});
});
