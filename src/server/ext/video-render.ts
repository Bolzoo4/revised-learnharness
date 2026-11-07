// src/server/ext/video-render.ts
/**
 * The render service (REQ-vid-05, 06, 07, 09): runs one Manim scene inside
 * the macOS sandbox, under a time limit, and returns the outcome.
 *
 * One render:
 *   1. a fresh work directory (real path) with the scene written in it;
 *   2. `sandbox-exec -p <profile> <runtime>/bin/manim -ql …`, cwd and TMPDIR in
 *      the work directory, a clean environment (no API keys, no home folder),
 *      in its own process group so a timeout or an abort kills the whole tree;
 *   3. the output file must exist and pass `ffprobe` (run sandboxed too) and
 *      the checks in core/ext/video/limits.ts;
 *   4. the mp4 is copied to outputPath (atomically) and the work directory is
 *      deleted, on success and on every failure.
 * Fails closed: without /usr/bin/sandbox-exec nothing runs.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { manimRuntimeRoot } from "../../agent/ext/video-runtime.ts";
import { classifyRunFailure, type VideoRenderOutcome } from "../../core/ext/video/outcome.ts";
import { checkRenderProbe, VIDEO_LIMITS } from "../../core/ext/video/limits.ts";
import { sandboxProfile } from "../../core/ext/video/sandbox-profile.ts";
import { jobVideoPath } from "../../store/ext/job-video.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Where `manim -ql -o scene --media_dir <work>/media` writes (the contract, plan "The contract between A and B"). */
const RENDERED = path.join("media", "videos", "scene", "480p15", "scene.mp4");
const PROBE_TIMEOUT_MS = 30_000;
/** Output kept per stream: the tail is what the model sees (outputTailChars). */
const KEEP_BYTES = 64 * 1024;

export interface RenderSceneOptions {
	/** The bundled runtime root (contains bin/manim and bin/ffprobe). */
	runtimeRoot: string;
	/** Where the finished mp4 is written on success. */
	outputPath: string;
	/** Time limit for the Manim run (default VIDEO_LIMITS.renderTimeoutMs). */
	timeoutMs?: number;
	/** Aborts the run: the process tree is killed and the work directory removed. */
	signal?: AbortSignal;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	killed: "timeout" | "aborted" | null;
}

/** Run one command under the sandbox in its own process group. */
function runSandboxed(
	argv: string[],
	opts: { profile: string; cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve({ code: null, stdout: "", stderr: "", killed: "aborted" });
			return;
		}
		const child = spawn(SANDBOX_EXEC, ["-p", opts.profile, ...argv], {
			cwd: opts.cwd,
			env: opts.env as NodeJS.ProcessEnv,
			detached: true, // own process group: one kill takes the whole tree
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed: RunResult["killed"] = null;
		const keep = (prev: string, chunk: Buffer) => (prev + chunk.toString("utf-8")).slice(-KEEP_BYTES);
		child.stdout.on("data", (chunk: Buffer) => (stdout = keep(stdout, chunk)));
		child.stderr.on("data", (chunk: Buffer) => (stderr = keep(stderr, chunk)));

		const killTree = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			killed = "timeout";
			killTree();
		}, opts.timeoutMs);
		const onAbort = () => {
			killed = "aborted";
			killTree();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const done = (code: number | null) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, killed });
		};
		child.on("error", (err) => {
			stderr += `\n${err.message}`;
			done(null);
		});
		child.on("close", (code) => done(code));
	});
}

/** The output of a run, for the fix loop: stdout then stderr, as the model reads them. */
function outputOf(run: RunResult): string {
	return [run.stdout, run.stderr].filter((s) => s.length > 0).join("\n");
}

/** Render one scene and write its mp4 to outputPath. Never throws. */
export async function renderScene(scene: string, opts: RenderSceneOptions): Promise<VideoRenderOutcome> {
	if (!fs.existsSync(SANDBOX_EXEC)) return { ok: false, reason: "failed", detail: "sandbox-exec is not available on this system" };
	if (!fs.existsSync(path.join(opts.runtimeRoot, "bin", "manim"))) {
		return { ok: false, reason: "no-runtime", detail: `no manim runtime at ${opts.runtimeRoot}` };
	}
	if (Buffer.byteLength(scene, "utf-8") > VIDEO_LIMITS.sceneMaxBytes) {
		return { ok: false, reason: "failed", detail: "the scene is larger than the limit" };
	}
	const timeoutMs = opts.timeoutMs ?? VIDEO_LIMITS.renderTimeoutMs;
	const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lh-video-"));
	try {
		const realWork = fs.realpathSync(work);
		const realRoot = fs.realpathSync(opts.runtimeRoot);
		const tmp = path.join(realWork, "tmp");
		fs.mkdirSync(tmp);
		const scenePath = path.join(realWork, "scene.py");
		fs.writeFileSync(scenePath, scene, "utf-8");
		const profile = sandboxProfile({ workDir: realWork, runtimeRoot: realRoot });
		const env = {
			PATH: `${realRoot}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: realWork,
			TMPDIR: tmp,
			LANG: "en_US.UTF-8",
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONNOUSERSITE: "1",
		};

		const manim = await runSandboxed(
			[
				path.join(realRoot, "bin", "manim"),
				"-ql",
				"--disable_caching",
				"--media_dir",
				path.join(realWork, "media"),
				"-o",
				"scene",
				scenePath,
				"Scene",
			],
			{ profile, cwd: realWork, env, timeoutMs, signal: opts.signal },
		);
		if (manim.killed) return { ok: false, reason: manim.killed, detail: outputOf(manim) };
		if (manim.code !== 0) return { ok: false, reason: classifyRunFailure(outputOf(manim)), detail: outputOf(manim) };

		const produced = path.join(realWork, RENDERED);
		if (!fs.existsSync(produced)) return { ok: false, reason: "no-output", detail: outputOf(manim) };

		const probe = await runSandboxed(
			[path.join(realRoot, "bin", "ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", produced],
			{ profile, cwd: realWork, env, timeoutMs: PROBE_TIMEOUT_MS, signal: opts.signal },
		);
		if (probe.killed) return { ok: false, reason: probe.killed, detail: outputOf(probe) };
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(probe.stdout);
		} catch {
			parsed = null;
		}
		const check = checkRenderProbe(parsed, fs.statSync(produced).size);
		if (!check.ok) return { ok: false, reason: "bad-output", detail: `${check.problem}\n${outputOf(probe)}` };

		fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
		const part = `${opts.outputPath}.part`;
		fs.copyFileSync(produced, part);
		fs.renameSync(part, opts.outputPath);
		return { ok: true, durationSec: check.durationSec };
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

export interface JobVideoRequest {
	jobId: string;
	scene: string;
	signal?: AbortSignal;
}

/** The job wiring: the bundled runtime (absent = refused) and the job's mp4 path. */
export async function renderJobVideo(req: JobVideoRequest): Promise<VideoRenderOutcome> {
	const runtimeRoot = manimRuntimeRoot();
	if (!runtimeRoot) return { ok: false, reason: "no-runtime", detail: "the manim runtime is not installed" };
	return renderScene(req.scene, { runtimeRoot, outputPath: jobVideoPath(req.jobId), signal: req.signal });
}
