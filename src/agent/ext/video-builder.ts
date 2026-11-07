// src/agent/ext/video-builder.ts
/**
 * The video-builder sub-agent (REQ-vid-04, 07, 08): given a brief it writes ONE
 * Manim scene, renders it through the injected render port (the sandboxed
 * render service in production), reads the render's own output on failure
 * and fixes the scene, within a bounded number of renders. Modelled on the
 * demo builder (src/agent/subagents/demo-builder.ts): two tools, a house rule
 * (never deliver an unrendered video), a verification gate before delivery.
 *
 * The render port is the only thing that touches the sandbox; this module
 * sees outcomes, never a path, a process or a file. Failure is a value:
 * { ok: false, notes: "FAILED: …" }, never an exception.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { serverExecute } from "../tool-execute.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "../subagents/pi-run.ts";
import { healToolRecord } from "../tools/heal.ts";
import { VIDEO_LIMITS } from "../../core/ext/video/limits.ts";
import { renderFailureNote, renderFeedback, type VideoRenderFailureReason, type VideoRenderOutcome } from "../../core/ext/video/outcome.ts";
import { resolveExtPrompt } from "./prompt-override.ts";

export interface VideoBuildInput {
	title: string;
	brief: string;
}

export interface VideoBuildOutcome {
	ok: boolean;
	/** The scene that is delivered (the last one written, when ok). */
	scene: string;
	durationSec: number;
	/** Maker notes when ok; "FAILED: …" when not. */
	notes: string;
}

export interface VideoBuildOptions {
	/** Test seam: scripted engine; production uses the demoBuilder role (shared with demo). */
	engine?: PiEngine;
	/** Renders one scene and reports the outcome. Production: the sandboxed render service. */
	render: (scene: string) => Promise<VideoRenderOutcome>;
	/** Fix attempts after the first render (default VIDEO_LIMITS.maxFixes). */
	maxFixes?: number;
	/** Max agent steps (default generous: each write and each render is one). */
	maxSteps?: number;
	abortSignal?: AbortSignal;
	/** Money channel: one call per agent step, folded into the job's usage. */
	onUsage?: (usage: Usage) => void;
	/** Live activity line (updates the job record). */
	onActivity?: (line: string) => void;
	chatId?: string;
}

/** The video builder's system prompt (the editable default, prompt-catalog id "video-builder"). */
export const VIDEO_BUILDER_INSTRUCTIONS = `You are a video builder — a specialist sub-agent inside a learning application. You receive a
brief for ONE short explanatory video and deliver a Manim (Community edition 0.22) scene that renders it. You never see
the lesson; the brief is everything you know.

Scene contract:
- One Python file. Start with \`from manim import *\`, then define the scene class exactly as
  \`class Scene(Scene):\` (the renderer asks for a class named Scene; its base is manim's Scene).
- Implement \`construct(self)\`. Keep it short: 10 to 40 seconds of animation, low-detail geometry.
- Text and formulas: \`Text(...)\` and \`MathTex(r"...")\` (LaTeX is available; keep formulas simple).
- The render is low quality (480p, 15 fps). Plan for it: large fonts, few objects on screen at once.

The sandbox (a hard rule, not a suggestion):
- The scene has NO network access and may write only inside its own folder. Do not open files, sockets,
  URLs, images, sounds, or subprocesses. Use only what manim provides, built in the scene itself.

THE HOUSE RULE — never deliver an unrendered video:
1. Call write_scene with the complete scene file.
2. Call render_video. It renders the scene in the sandbox and reports PASSED, or FAILED with the render's own
   output tail.
3. If it FAILED, read the output, FIX the scene (write_scene), and render again. Stop when it reports PASSED or
   when renders are used up.
4. Only then finish. Your final message is 1 to 3 sentences of NOTES for the teacher (what the video shows and
   what to watch for). Never the scene source itself.

Never claim success you did not see: a PASSED render is the only definition of done.`;

interface BuilderState {
	scene: string | null;
	/** The scene the last render tested (null = never rendered). */
	lastRendered: string | null;
	/** The last passing render, with the scene it passed for. */
	passed: { scene: string; durationSec: number } | null;
	/** The reason of the last failed render (learner-facing text is built from it). */
	lastReason: VideoRenderFailureReason | null;
	renders: number;
}

const writeSceneInput = Type.Object({
	scene: Type.String({ description: "The complete Manim scene file (Python). It must define `class Scene(Scene):`." }),
});

const renderVideoInput = Type.Object({});

export function createVideoBuilderTools(
	state: BuilderState,
	render: (scene: string) => Promise<VideoRenderOutcome>,
	maxFixes: number,
	onActivity?: (line: string) => void,
): Record<string, AgentTool<any>> {
	return healToolRecord({
		write_scene: {
			name: "write_scene",
			label: "write_scene",
			description:
				"Write the complete Manim scene file (overwrites any previous version). Always follow with render_video to test it.",
			parameters: writeSceneInput,
			execute: serverExecute("write_scene", writeSceneInput, async ({ scene }) => {
				if (!scene || scene.trim().length === 0) return "ERROR: empty scene — write the full file.";
				if (Buffer.byteLength(scene, "utf-8") > VIDEO_LIMITS.sceneMaxBytes) {
					return `ERROR: the scene is over ${VIDEO_LIMITS.sceneMaxBytes} bytes — shorten it.`;
				}
				if (!/class\s+Scene\s*\(/.test(scene)) {
					return "ERROR: the scene must define `class Scene(Scene):` — the renderer looks for that class.";
				}
				state.scene = scene;
				onActivity?.(`write_scene: ${(scene.length / 1024).toFixed(1)} KB`);
				return `Saved (${scene.length} characters). Now call render_video to test it — never deliver unrendered.`;
			}),
		},
		render_video: {
			name: "render_video",
			label: "render_video",
			description:
				"Render the current scene in the sandbox and report PASSED, or FAILED with the render's own output. " +
				"Renders are limited; use each one to test a real fix.",
			parameters: renderVideoInput,
			execute: serverExecute("render_video", renderVideoInput, async () => {
				if (!state.scene) return "ERROR: nothing to render — call write_scene first.";
				if (state.renders >= maxFixes + 1) {
					return `LIMIT: ${state.renders} render attempts are used up. No more renders: finish now with notes on what you tried.`;
				}
				const scene = state.scene;
				state.renders++;
				onActivity?.(`rendering (attempt ${state.renders})`);
				let outcome: VideoRenderOutcome;
				try {
					outcome = await render(scene);
				} catch {
					outcome = { ok: false, reason: "failed", detail: "the render service crashed" };
				}
				state.lastRendered = scene;
				if (outcome.ok) {
					state.passed = { scene, durationSec: outcome.durationSec };
					state.lastReason = null;
					onActivity?.("rendered");
				} else {
					state.lastReason = outcome.reason;
					onActivity?.(`render failed: ${outcome.reason}`);
				}
				return renderFeedback(outcome);
			}),
		},
	});
}

export async function runVideoBuilder(input: VideoBuildInput, opts: VideoBuildOptions): Promise<VideoBuildOutcome> {
	const title = input.title.trim() || "Video";
	const brief = input.brief.trim() || "(no brief)";
	const maxFixes = opts.maxFixes ?? VIDEO_LIMITS.maxFixes;
	const state: BuilderState = { scene: null, lastRendered: null, passed: null, lastReason: null, renders: 0 };
	const prompt = [
		`Video title: ${title}`,
		"Brief (all you know about the lesson — this comes from the teacher, verbatim):",
		brief,
		"",
		"Write the scene, render it, fix it until PASSED, then finish with your notes.",
	].join("\n");

	let finalText = "";
	try {
		const result = await runSubagent(
			Object.values(createVideoBuilderTools(state, opts.render, maxFixes, opts.onActivity)),
			{
				role: "demoBuilder",
				engine: opts.engine,
				systemPrompt: resolveExtPrompt("video-builder", VIDEO_BUILDER_INSTRUCTIONS),
				prompt,
				maxTurns: opts.maxSteps ?? 4 * (maxFixes + 1) + 4,
				abortSignal: opts.abortSignal,
				onUsage: (usage) => opts.onUsage?.(usage),
				onToolStart: (toolName) => opts.onActivity?.(toolName),
				chatId: opts.chatId,
			},
		);
		finalText = result.text;
	} catch {
		// Exception text never reaches the learner (REQ-vid-08): a fixed sentence.
		return { ok: false, scene: "", durationSec: 0, notes: "FAILED: the video builder stopped unexpectedly." };
	}

	if (!state.scene) {
		return { ok: false, scene: "", durationSec: 0, notes: `FAILED: the builder never wrote a scene.${finalText ? ` (${finalText.slice(0, 300)})` : ""}` };
	}
	const notes = finalText.trim();
	if (state.passed && state.passed.scene === state.scene) {
		return { ok: true, scene: state.scene, durationSec: state.passed.durationSec, notes };
	}
	// The verify gate: the delivered scene must have a passing render, even when
	// the model forgot the final render. A scene that was rendered and failed is
	// not re-rendered: its failure stands.
	if (state.lastRendered !== state.scene) {
		opts.onActivity?.("final verification");
		let verify: VideoRenderOutcome;
		try {
			verify = await opts.render(state.scene);
		} catch {
			verify = { ok: false, reason: "failed", detail: "the render service crashed" };
		}
		if (verify.ok) return { ok: true, scene: state.scene, durationSec: verify.durationSec, notes };
		return { ok: false, scene: state.scene, durationSec: 0, notes: `FAILED: ${renderFailureNote(verify.reason)}` };
	}
	return { ok: false, scene: state.scene, durationSec: 0, notes: `FAILED: ${renderFailureNote(state.lastReason ?? "failed")}` };
}
