"use client";

import { useState } from "react";
import { CodeIcon } from "lucide-react";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, VideoResult } from "@/src/core";

/**
 * The video artifact (REQ-vid-10). While the tool call is pending, the
 * dispatch card shows the job's live activity (components/artifacts/dispatch-card.tsx).
 * When the render is delivered, the steer card renders this: the title, the
 * mp4 in a native player, and "Show scene" for the Manim source. The player
 * is a plain <video> with the job's file served by /api/ext/videos/<jobId>.
 * Light and dark themes: the page tokens (bg-card, text-card-foreground,
 * muted) carry the colours; the video frame is black in both.
 */

/** The URL of one job's video (the route validates the id). */
export function videoUrlFor(jobId: string): string {
	return `/api/ext/videos/${jobId}`;
}

/** The tool-call box: the output is the dispatch ack, so the box is the dispatch card. */
export function VideoCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="video" />;
}

/** The delivered video, from the steer message's result. */
export function VideoOutputCard({ output }: { output: unknown }) {
	const result = output as VideoResult | undefined;
	if (!result || typeof result.title !== "string" || typeof result.jobId !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Video completed, but the result could not be displayed.
			</div>
		);
	}
	if (result.jobId.length === 0) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="video-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Video
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The video could not be made."}</p>
			</div>
		);
	}
	return <VideoPlayer title={result.title} jobId={result.jobId} scene={result.scene} />;
}

function VideoPlayer({ title, jobId, scene }: { title: string; jobId: string; scene: string }) {
	const [showScene, setShowScene] = useState(false);
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="video-card">
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">video</span>
					<span className="truncate text-xs font-medium tracking-wide text-foreground">{title}</span>
				</div>
				<button
					type="button"
					onClick={() => setShowScene((v) => !v)}
					aria-pressed={showScene}
					className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					data-testid="video-scene-toggle"
				>
					<CodeIcon className="size-3.5" />
					{showScene ? "Hide scene" : "Show scene"}
				</button>
			</div>
			<video
				controls
				playsInline
				preload="metadata"
				src={videoUrlFor(jobId)}
				aria-label={title}
				className="mt-2 w-full rounded-lg bg-black"
				data-testid="video-player"
			/>
			{showScene && (
				<pre
					className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground"
					data-testid="video-scene"
				>
					{scene}
				</pre>
			)}
		</div>
	);
}
