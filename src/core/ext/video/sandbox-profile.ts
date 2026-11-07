// src/core/ext/video/sandbox-profile.ts
/**
 * The macOS sandbox profile for one render (REQ-vid-06), as sandbox-exec
 * (SBPL) text. Pure: the caller passes resolved (real) absolute paths; this
 * module only validates them and writes the rules.
 *
 * The rules, in order of what they protect:
 *   - deny by default; deny every network operation (no DNS, no sockets);
 *   - writes only inside the per-render work directory (and /dev/null and the
 *     one tty-free device the runtime's loader touches);
 *   - reads only the system (libraries, frameworks, dyld cache), the runtime
 *     root and the work directory, plus file metadata (path resolution);
 *   - process exec and fork are allowed: the scene runs the bundled Python,
 *     Manim and ffmpeg, which is the job.
 * The home folder, the app's data and every other path are unreadable and
 * unwritable. Verified on this Mac by tests/ext-video-sandbox.test.ts.
 */

export interface SandboxProfileOptions {
	/** The per-render work directory (real path, absolute). Read and write. */
	workDir: string;
	/** The bundled runtime root (real path, absolute). Read only. */
	runtimeRoot: string;
}

/** A path may appear in SBPL only as a plain absolute path with no quotes,
 *  backslashes or control characters (the profile is text, not escaped). */
function sbplPath(label: string, value: string): string {
	if (typeof value !== "string" || !value.startsWith("/")) throw new Error(`${label} must be an absolute path`);
	if (/["\\\u0000-\u001f]/.test(value)) throw new Error(`${label} contains characters the sandbox profile cannot hold`);
	return value;
}

export function sandboxProfile(opts: SandboxProfileOptions): string {
	const work = sbplPath("workDir", opts.workDir);
	const runtime = sbplPath("runtimeRoot", opts.runtimeRoot);
	return [
		"(version 1)",
		"(deny default)",
		"; the scene runs the bundled Python, Manim and ffmpeg",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix-shm*)",
		"; path resolution and the system libraries, the dyld cache and the shell",
		"(allow file-read-metadata)",
		'(allow file-read-data (literal "/"))',
		'(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library"))',
		'(allow file-read* (subpath "/private/var/db/dyld") (subpath "/private/var/select") (subpath "/private/etc"))',
		'(allow file-read* (subpath "/dev"))',
		`(allow file-read* (subpath "${runtime}"))`,
		"; the work directory: the only place a render may write",
		`(allow file-read* file-write* (subpath "${work}"))`,
		'(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
		"; no network, in any form",
		"(deny network*)",
		"",
	].join("\n");
}
