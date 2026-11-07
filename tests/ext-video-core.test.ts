/**
 * Video core (pure) tests — REQ-vid-04, 05, 06, 07, 08:
 *   - input checks for the video tool (title / brief bounds)
 *   - the ffprobe output check (duration, mp4 container, size bound)
 *   - the sandbox profile text (deny network, writes only in the work dir,
 *     reads only system + runtime + work dir; path validation)
 *   - the render outcome vocabulary: learner-safe failure note, model-facing
 *     feedback, sandbox denial classification
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VIDEO_LIMITS, checkRenderProbe, checkVideoInput } from "../src/core/ext/video/limits.ts";
import { sandboxProfile } from "../src/core/ext/video/sandbox-profile.ts";
import { classifyRunFailure, renderFailureNote, renderFeedback, type VideoRenderOutcome } from "../src/core/ext/video/outcome.ts";

describe("checkVideoInput (REQ-vid-04)", () => {
	it("accepts a title and a brief and trims them", () => {
		const r = checkVideoInput({ title: "  Sigma algebras  ", brief: " Show why unions fail. " });
		assert.deepEqual(r, { ok: true, title: "Sigma algebras", brief: "Show why unions fail." });
	});

	it("rejects an empty or blank title and brief, naming each field", () => {
		const r = checkVideoInput({ title: "   ", brief: "" });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.problems.length, 2);
		assert.match(r.problems[0]!, /title/);
		assert.match(r.problems[1]!, /brief/);
	});

	it("rejects over-long values", () => {
		const r = checkVideoInput({ title: "t".repeat(VIDEO_LIMITS.titleMaxChars + 1), brief: "b".repeat(VIDEO_LIMITS.briefMaxChars + 1) });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.problems.length, 2);
	});

	it("rejects non-string inputs without throwing", () => {
		const r = checkVideoInput({ title: 3, brief: null });
		assert.equal(r.ok, false);
	});
});

describe("checkRenderProbe (REQ-vid-07)", () => {
	const good = {
		format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" },
		streams: [{ codec_type: "video" }],
	};

	it("accepts an mp4 with a video stream and a positive duration", () => {
		assert.deepEqual(checkRenderProbe(good, 10_000), { ok: true, durationSec: 2 });
	});

	it("rejects an empty file", () => {
		assert.equal(checkRenderProbe(good, 0).ok, false);
	});

	it("rejects a file over the size limit", () => {
		assert.equal(checkRenderProbe(good, VIDEO_LIMITS.outputMaxBytes + 1).ok, false);
	});

	it("rejects zero duration, a non-mp4 container, or no video stream", () => {
		assert.equal(checkRenderProbe({ ...good, format: { ...good.format, duration: "0.000000" } }, 10).ok, false);
		assert.equal(checkRenderProbe({ ...good, format: { ...good.format, format_name: "wav" } }, 10).ok, false);
		assert.equal(checkRenderProbe({ ...good, streams: [{ codec_type: "audio" }] }, 10).ok, false);
	});

	it("rejects unparseable probe output", () => {
		assert.equal(checkRenderProbe(null, 10).ok, false);
		assert.equal(checkRenderProbe("garbage", 10).ok, false);
		assert.equal(checkRenderProbe({ format: { duration: "NaN", format_name: "mp4" }, streams: [] }, 10).ok, false);
	});
});

describe("sandboxProfile (REQ-vid-06)", () => {
	const profile = sandboxProfile({ workDir: "/private/var/folders/x/lh-video-abc", runtimeRoot: "/Apps/LearnHarness/manim-runtime" });

	it("denies everything by default and denies the network", () => {
		assert.match(profile, /\(deny default\)/);
		assert.match(profile, /\(deny network\*\)/);
		assert.equal(/\(allow network/.test(profile), false);
	});

	it("allows writes only under the work directory (and /dev/null)", () => {
		const writeLines = profile.split("\n").filter((l) => l.includes("file-write"));
		assert.ok(writeLines.length >= 1);
		for (const line of writeLines) {
			const allowsWorkDirOnly = line.includes('(subpath "/private/var/folders/x/lh-video-abc")');
			const allowsDevNull = line.includes('(literal "/dev/null")');
			assert.ok(allowsWorkDirOnly || allowsDevNull, `unexpected write rule: ${line}`);
		}
	});

	it("reads the runtime and the work directory, not the home folder", () => {
		assert.match(profile, /\(allow file-read\*[^\n]*\(subpath "\/Apps\/LearnHarness\/manim-runtime"\)/);
		assert.equal(profile.includes("/Users/"), false);
	});

	it("rejects relative paths and paths that could break the profile syntax", () => {
		assert.throws(() => sandboxProfile({ workDir: "relative/dir", runtimeRoot: "/r" }));
		assert.throws(() => sandboxProfile({ workDir: '/w"x', runtimeRoot: "/r" }));
		assert.throws(() => sandboxProfile({ workDir: "/w\\x", runtimeRoot: "/r" }));
		assert.throws(() => sandboxProfile({ workDir: "/w", runtimeRoot: "/r\n(allow default)" }));
	});
});

describe("render outcomes (REQ-vid-08)", () => {
	it("the learner-facing failure note is fixed text: no detail leaks", () => {
		const note = renderFailureNote("denied");
		assert.match(note, /^The video could not be made/);
		assert.equal(note.includes("Operation not permitted"), false);
		for (const reason of ["timeout", "aborted", "denied", "failed", "no-output", "bad-output", "no-runtime"] as const) {
			assert.ok(renderFailureNote(reason).length > 0);
		}
	});

	it("the model-facing feedback carries the render's own output tail and a sandbox hint on denial", () => {
		const denied: VideoRenderOutcome = { ok: false, reason: "denied", detail: "PermissionError: Operation not permitted" };
		const text = renderFeedback(denied);
		assert.match(text, /FAILED/);
		assert.match(text, /Operation not permitted/);
		assert.match(text, /network|outside/i);
		const ok: VideoRenderOutcome = { ok: true, durationSec: 2.5 };
		assert.match(renderFeedback(ok), /PASSED/);
	});

	it("classifies a run's stderr as a sandbox denial only for permission errors", () => {
		assert.equal(classifyRunFailure("OSError: [Errno 1] Operation not permitted: '/x'"), "denied");
		assert.equal(classifyRunFailure("Permission denied"), "denied");
		assert.equal(classifyRunFailure("NameError: name 'x' is not defined"), "failed");
	});
});
