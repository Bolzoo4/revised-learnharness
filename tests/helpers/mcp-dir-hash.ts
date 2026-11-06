// tests/helpers/mcp-dir-hash.ts
/**
 * The immutability oracle (REQ-mcp-02). `treeDigest` walks a directory
 * recursively and records, for every entry (file, directory, symlink): its
 * relative path, type, size, mtime in nanoseconds, inode and, for files, the
 * sha256 of the content. Directory mtimes are included on purpose: creating
 * and deleting a temporary or lock file leaves no file behind but changes the
 * directory's mtime. atime is excluded (a read may legitimately change it).
 * `fsTripwire` additionally makes every write API of node:fs throw while a
 * tool runs, so a write to ANY path (not only the data directory) is caught.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

export function treeDigest(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			const st = fs.lstatSync(full, { bigint: true });
			const rel = path.relative(root, full);
			const type = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
			const content = type === "f" ? createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "";
			lines.push(`${rel}|${type}|${st.size}|${st.mtimeNs}|${st.ino}|${content}`);
			if (type === "d") walk(full);
		}
	};
	const rootStat = fs.lstatSync(root, { bigint: true });
	lines.push(`.|d|${rootStat.mtimeNs}`);
	walk(root);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

type Fn = (...args: unknown[]) => unknown;
type Table = Record<string, Fn>;
const WRITE_APIS = [
	"writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync",
	"cpSync", "truncateSync", "ftruncateSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "utimesSync", "writeSync",
	"createWriteStream",
] as const;

/** While active, any call to a write API of node:fs throws. Returns the restore function. */
export function fsTripwire(): { calls: string[]; restore(): void } {
	const calls: string[] = [];
	const restores: Array<() => void> = [];
	for (const name of WRITE_APIS) {
		const m = mock.method(fs as unknown as Table, name, (..._args: unknown[]) => {
			calls.push(name);
			throw new Error(`fs.${name} called while the read-only server was running`);
		});
		restores.push(() => m.mock.restore());
	}
	const promises = fs.promises as unknown as Table;
	for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rename", "unlink", "copyFile", "truncate"]) {
		const m = mock.method(promises, name, async () => {
			calls.push(`promises.${name}`);
			throw new Error(`fs.promises.${name} called while the read-only server was running`);
		});
		restores.push(() => m.mock.restore());
	}
	// openSync with a write flag is a write too; read opens pass through.
	const realOpen = fs.openSync.bind(fs);
	const open = mock.method(fs as unknown as Table, "openSync", (p: unknown, flags?: unknown, mode?: unknown) => {
		const writes = typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
		if (writes) {
			calls.push("openSync(write)");
			throw new Error("fs.openSync for writing called while the read-only server was running");
		}
		return (realOpen as Fn)(p, flags, mode);
	});
	restores.push(() => open.mock.restore());
	return { calls, restore: () => restores.reverse().forEach((r) => r()) };
}
