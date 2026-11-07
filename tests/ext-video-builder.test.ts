/**
 * The video-builder sub-agent (src/agent/ext/video-builder.ts) with a FAKE
 * model (faux engine) and a FAKE render port (REQ-vid-04, 07, 08):
 *   - write, render, fix, render again → delivered with the passing scene
 *   - a scene without `class Scene(` is refused by write_scene
 *   - the fix loop is bounded: after maxFixes+1 renders no more attempts run
 *   - a model that never renders gets a final verification render
 *   - a render port that throws becomes a failure, never an exception
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { runVideoBuilder } from "../src/agent/ext/video-builder.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { VideoRenderOutcome } from "../src/core/ext/video/outcome.ts";

type Turn = { toolCalls?: Array<{ id: string; name: string; input: unknown }>; text?: string };

function scripted(turns: Turn[]): PiEngine {
	const steps: FauxResponseStep[] = turns.map((t) =>
		t.toolCalls
			? fauxAssistantMessage(
					t.toolCalls.map((c) => fauxToolCall(c.name, c.input as ToolCall["arguments"], { id: c.id })),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(t.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const GOOD_1 = "from manim import *\nclass Scene(Scene):\n    def construct(self):\n        self.play(Create(Circle()))\n";
const GOOD_2 = "from manim import *\nclass Scene(Scene):\n    def construct(self):\n        self.wait(1)\n";
const BAD = "from manim import *\nprint('no scene class here')\n";

const PASS = (durationSec: number): VideoRenderOutcome => ({ ok: true, durationSec });
const FAIL: VideoRenderOutcome = { ok: false, reason: "failed", detail: "NameError: name 'boom' is not defined" };

describe("runVideoBuilder (fake model, fake render)", () => {
	it("writes, renders, fixes after a failed render, and delivers the passing scene", async () => {
		const scenes: string[] = [];
		const outcomes: VideoRenderOutcome[] = [FAIL, PASS(2.5)];
		const engine = scripted([
			{ toolCalls: [{ id: "w0", name: "write_scene", input: { scene: BAD } }] },
			{ toolCalls: [{ id: "w1", name: "write_scene", input: { scene: GOOD_1 } }] },
			{ toolCalls: [{ id: "r1", name: "render_video", input: {} }] },
			{ toolCalls: [{ id: "w2", name: "write_scene", input: { scene: GOOD_2 } }] },
			{ toolCalls: [{ id: "r2", name: "render_video", input: {} }] },
			{ text: "A circle drawn in two seconds." },
		]);
		const result = await runVideoBuilder(
			{ title: "Circle", brief: "Draw a circle." },
			{
				engine,
				render: async (scene) => {
					scenes.push(scene);
					return outcomes.shift()!;
				},
			},
		);
		assert.equal(result.ok, true);
		assert.equal(result.scene, GOOD_2);
		assert.equal(result.durationSec, 2.5);
		assert.equal(result.notes, "A circle drawn in two seconds.");
		assert.deepEqual(scenes, [GOOD_1, GOOD_2]);
	});

	it("bounds the fix loop: no render beyond maxFixes + 1 attempts, and the result is a failure", async () => {
		let renders = 0;
		const turns: Turn[] = [{ toolCalls: [{ id: "w", name: "write_scene", input: { scene: GOOD_1 } }] }];
		for (let i = 0; i < 8; i++) turns.push({ toolCalls: [{ id: `r${i}`, name: "render_video", input: {} }] });
		turns.push({ text: "giving up" });
		const result = await runVideoBuilder(
			{ title: "Never", brief: "Never renders." },
			{
				engine: scripted(turns),
				maxFixes: 1,
				render: async () => {
					renders++;
					return FAIL;
				},
			},
		);
		assert.equal(result.ok, false);
		assert.ok(renders <= 2, `renders=${renders}`);
		assert.match(result.notes, /^FAILED/);
	});

	it("a model that never renders gets one final verification render before delivery", async () => {
		let renders = 0;
		const engine = scripted([
			{ toolCalls: [{ id: "w", name: "write_scene", input: { scene: GOOD_1 } }] },
			{ text: "done, I think" },
		]);
		const result = await runVideoBuilder(
			{ title: "Unverified", brief: "b" },
			{
				engine,
				render: async () => {
					renders++;
					return PASS(1);
				},
			},
		);
		assert.equal(renders, 1);
		assert.equal(result.ok, true);
		assert.equal(result.scene, GOOD_1);
	});

	it("a model that never writes a scene fails honestly", async () => {
		const result = await runVideoBuilder(
			{ title: "Empty", brief: "b" },
			{ engine: scripted([{ text: "I could not" }]), render: async () => PASS(1) },
		);
		assert.equal(result.ok, false);
		assert.match(result.notes, /never wrote a scene/);
	});

	it("a render port that throws becomes a failed result, never an exception", async () => {
		const result = await runVideoBuilder(
			{ title: "Crash", brief: "b" },
			{
				engine: scripted([
					{ toolCalls: [{ id: "w", name: "write_scene", input: { scene: GOOD_1 } }] },
					{ toolCalls: [{ id: "r", name: "render_video", input: {} }] },
					{ text: "x" },
				]),
				render: async () => {
					throw new Error("boom");
				},
			},
		);
		assert.equal(result.ok, false);
		assert.match(result.notes, /FAILED/);
	});
});
