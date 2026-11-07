// src/store/ext/job-video.ts
/**
 * The rendered video of a `video` job lives BESIDE its job record:
 *   data/jobs/<jobId>.json   the job record (upstream JobStore, unchanged)
 *   data/jobs/<jobId>.mp4    the finished video (this file)
 * The JobStore lists only *.json, so the mp4 is invisible to it, and
 * deleteJobsForChat calls removeJobVideo so the video dies with its job
 * (REQ-vid-13). Layout: docs/ext/CONTRACTS.md, "Video".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");

/** The mp4 path for one job id (the id is checked, so no path can escape the folder). */
export function jobVideoPath(jobId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
	return path.join(JOBS_DIR, `${jobId}.mp4`);
}

/** Remove a job's video if it exists. Never throws: a missing file is the normal case. */
export function removeJobVideo(jobId: string): void {
	try {
		fs.rmSync(jobVideoPath(jobId), { force: true });
	} catch {
		/* a bad id or a locked file: the job record is what matters for deletion */
	}
}
