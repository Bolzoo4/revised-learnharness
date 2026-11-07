/**
 * The render service (src/server/ext/video-render.ts) against a FAKE runtime:
 * a sh `bin/manim` that acts on a marker in the scene file (ok, fail,
 * denied, sleep, network, outside-write) and copies a small mp4 fixture to the
 * expected output path, and a sh `bin/ffprobe` that prints probe JSON.
 * Everything runs under the real sandbox-exec (skipped only without it).
 *
 * Covers REQ-vid-05 (time limit kills the process tree), REQ-vid-06 (network
 * and outside writes fail the job, recorded as a denial), REQ-vid-07 (output
 * check), REQ-vid-09 (abort kills and deletes the work directory), REQ-vid-12
 * (runtime resolution: absent = null, env override wins).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { manimRuntimeRoot } from "../src/agent/ext/video-runtime.ts";
import { renderScene } from "../src/server/ext/video-render.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/ext-video-fixture.mp4", import.meta.url));
const HAS_SANDBOX = fs.existsSync("/usr/bin/sandbox-exec");

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lh-render-test-"));
const outDir = path.join(base, "out");
fs.mkdirSync(outDir);

/** A fake runtime root: bin/manim and bin/ffprobe, both plain sh. */
function makeFakeRuntime(name: string): string {
	const root = path.join(base, name);
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	const manim = `#!/bin/sh
media=""; scene=""
while [ $# -gt 0 ]; do
  case "$1" in
    --media_dir) media="$2"; shift 2;;
    -o) shift 2;;
    -*) shift;;
    *.py) scene="$1"; shift;;
    *) shift;;
  esac
done
echo "WORK=$(dirname "$media")"
marker=$(cat "$scene")
case "$marker" in
  *"#FAKE:sleep"*)
    sleep 60 &
    echo "CHILD=$!"
    wait
    ;;
  *"#FAKE:fail"*)
    echo "NameError: name 'boom' is not defined" >&2
    exit 1
    ;;
  *"#FAKE:denied"*)
    echo "OSError: [Errno 1] Operation not permitted: '/x'" >&2
    exit 1
    ;;
  *"#FAKE:network"*)
    port=$(echo "$marker" | sed -n 's/.*#FAKE:network \\([0-9]*\\).*/\\1/p')
    /usr/bin/nc -z -w 3 127.0.0.1 "$port" || { echo "connect failed" >&2; exit 1; }
    ;;
  *"#FAKE:outside"*)
    target=$(echo "$marker" | sed -n 's/.*#FAKE:outside \\([^ ]*\\).*/\\1/p')
    echo x > "$target" || exit 1
    ;;
  *"#FAKE:ok"*)
    mkdir -p "$media/videos/scene/480p15"
    cp "__FIXTURE__" "$media/videos/scene/480p15/scene.mp4"
    ;;
  *)
    echo "unknown scenario" >&2
    exit 2
    ;;
esac
`;
	const ffprobe = `#!/bin/sh
f=""
for a in "$@"; do f="$a"; done
[ -s "$f" ] || { echo "no file" >&2; exit 1; }
printf '{"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1.000000"},"streams":[{"codec_type":"video"}]}\\n'
`;
	// The fixture ships inside the fake runtime: the sandbox may read the runtime, not the repository.
	fs.copyFileSync(FIXTURE, path.join(root, "fixture.mp4"));
	fs.writeFileSync(path.join(root, "bin", "manim"), manim.replace('"__FIXTURE__"', '"' + path.join(root, "fixture.mp4") + '"'), { mode: 0o755 });
	fs.writeFileSync(path.join(root, "bin", "ffprobe"), ffprobe, { mode: 0o755 });
	return root;
}

const runtime = makeFakeRuntime("runtime");

after(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

function outputPath(name: string): string {
	return path.join(outDir, `${name}.mp4`);
}

function workDirFrom(detail: string): string | null {
	const m = /WORK=(\S+)/.exec(detail);
	return m ? m[1]! : null;
}

describe("renderScene with the fake runtime (REQ-vid-05..07, 09)", { skip: !HAS_SANDBOX && "sandbox-exec is not on this machine" }, () => {
	it("a passing scene writes the mp4 to the output path and reports the probed duration", async () => {
		const out = outputPath("ok");
		const r = await renderScene("#FAKE:ok\nclass Scene(Scene): pass\n", { runtimeRoot: runtime, outputPath: out, timeoutMs: 20_000 });
		assert.deepEqual(r, { ok: true, durationSec: 1 });
		assert.deepEqual(fs.readFileSync(out), fs.readFileSync(FIXTURE));
	});

	it("a failing scene reports the render's own output and deletes its work directory", async () => {
		const out = outputPath("fail");
		const r = await renderScene("#FAKE:fail\n", { runtimeRoot: runtime, outputPath: out, timeoutMs: 20_000 });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "failed");
		assert.match(r.detail, /NameError/);
		assert.equal(fs.existsSync(out), false);
		const work = workDirFrom(r.detail);
		assert.ok(work, "the fake reports its work directory");
		assert.equal(fs.existsSync(work!), false, "the work directory is removed");
	});

	it("a permission error inside the sandbox is classified as a denial", async () => {
		const r = await renderScene("#FAKE:denied\n", { runtimeRoot: runtime, outputPath: outputPath("denied"), timeoutMs: 20_000 });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "denied");
	});

	it("a write outside the work directory is refused by the sandbox and fails the render", async () => {
		const target = path.join(outDir, "escaped.txt");
		const r = await renderScene(`#FAKE:outside ${target}\n`, { runtimeRoot: runtime, outputPath: outputPath("outside"), timeoutMs: 20_000 });
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "denied");
		assert.equal(fs.existsSync(target), false);
	});

	it("a network connection to a local listener is refused, so the render fails", async () => {
		const server = net.createServer((socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const port = (server.address() as net.AddressInfo).port;
		try {
			const r = await renderScene(`#FAKE:network ${port}\n`, { runtimeRoot: runtime, outputPath: outputPath("net"), timeoutMs: 20_000 });
			assert.equal(r.ok, false);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("the time limit kills the whole process tree and fails the render", async () => {
		const r = await renderScene("#FAKE:sleep\n", { runtimeRoot: runtime, outputPath: outputPath("slow"), timeoutMs: 1_500 });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.equal(r.reason, "timeout");
		const child = /CHILD=(\d+)/.exec(r.detail);
		assert.ok(child, "the fake reports its background child");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.throws(() => process.kill(Number(child![1]), 0), "the background child is gone");
	});

	it("an abort kills the render, reports aborted, and deletes the work directory", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 800);
		const started = Date.now();
		const r = await renderScene("#FAKE:sleep\n", { runtimeRoot: runtime, outputPath: outputPath("aborted"), timeoutMs: 30_000, signal: controller.signal });
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.reason, "aborted");
			const work = workDirFrom(r.detail);
			if (work) assert.equal(fs.existsSync(work), false);
		}
		assert.ok(Date.now() - started < 10_000, "the abort does not wait for the time limit");
	});

	it("a runtime directory that does not exist is reported as no-runtime", async () => {
		const r = await renderScene("#FAKE:ok\n", { runtimeRoot: path.join(base, "missing"), outputPath: outputPath("none"), timeoutMs: 5_000 });
		assert.deepEqual(r, { ok: false, reason: "no-runtime", detail: r.ok ? "" : r.detail });
	});
});

describe("manimRuntimeRoot (REQ-vid-12)", () => {
	it("is null when no runtime is configured or the directory is absent", () => {
		assert.equal(manimRuntimeRoot({}, undefined), null);
		assert.equal(manimRuntimeRoot({ LH_MANIM_RUNTIME: path.join(base, "nope") }, undefined), null);
	});

	it("uses the env override when it holds bin/manim and bin/ffprobe", () => {
		assert.equal(manimRuntimeRoot({ LH_MANIM_RUNTIME: runtime }, undefined), runtime);
	});

	it("falls back to the packaged resources folder", () => {
		const resources = path.join(base, "Resources");
		fs.mkdirSync(path.join(resources, "manim-runtime", "bin"), { recursive: true });
		fs.writeFileSync(path.join(resources, "manim-runtime", "bin", "manim"), "");
		fs.writeFileSync(path.join(resources, "manim-runtime", "bin", "ffprobe"), "");
		assert.equal(manimRuntimeRoot({}, resources), path.join(resources, "manim-runtime"));
	});
});
