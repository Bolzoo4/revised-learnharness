import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoOutputCard, videoUrlFor } from "../components/ext/video-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import type { LhViewMessage } from "../src/core/index.ts";

const SCENE = "class Scene(Scene):\n    def construct(self):\n        self.wait(1)\n";

describe("VideoOutputCard (REQ-vid-10)", () => {
	it("plays the job's mp4 with its title, and hides the scene until asked", () => {
		const html = renderToStaticMarkup(
			<VideoOutputCard output={{ title: "Waiting", jobId: "job_42", scene: SCENE, durationSec: 1 }} />,
		);
		assert.ok(html.includes('data-testid="video-card"'));
		assert.ok(html.includes("Waiting"));
		assert.ok(html.includes(`src="${videoUrlFor("job_42")}"`));
		assert.equal(videoUrlFor("job_42"), "/api/ext/videos/job_42");
		assert.ok(html.includes("Show scene"));
		assert.equal(html.includes("self.wait(1)"), false, "the scene source is hidden by default");
	});

	it("a failed video shows the failure note and no player", () => {
		const html = renderToStaticMarkup(
			<VideoOutputCard output={{ title: "Broken", jobId: "", scene: "", durationSec: 0, notes: "FAILED: the render was denied" }} />,
		);
		assert.ok(html.includes('data-testid="video-card-failed"'));
		assert.ok(html.includes("the render was denied"));
		assert.equal(html.includes("<video"), false);
	});

	it("a malformed output says it could not be displayed", () => {
		const html = renderToStaticMarkup(<VideoOutputCard output={{ nope: true }} />);
		assert.ok(html.includes("could not be displayed"));
	});

	it("the steer card routes a video result to the player", () => {
		const message = {
			id: "steer_job_7",
			role: "user",
			parts: [
				{
					type: "data-subagent-artifact",
					data: { kind: "video", result: { title: "Steered", jobId: "job_7", scene: SCENE, durationSec: 2 } },
				},
			],
		} as unknown as LhViewMessage;
		const html = renderToStaticMarkup(<SubagentSteerCard message={message} />);
		assert.ok(html.includes(`src="${videoUrlFor("job_7")}"`));
	});

	it("the artifact registry has no separate video renderer for the tool part beyond the dispatch card", () => {
		assert.equal(typeof artifactRenderers["video"], "function");
	});
});
