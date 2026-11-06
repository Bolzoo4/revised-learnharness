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

/**
 * Every fs function whose name starts with one of these is a write API (or can
 * create, truncate or re-permission a file). The match is by name over the
 * whole module, so a function added to node:fs later is caught too.
 */
export const WRITE_NAME = /^(write|append|mk|rm|rename|unlink|copy|cp|truncate|open|symlink|link|chmod|chown|utimes|lchmod|lchown|lutimes|rmdir|mkdtemp|create|ftruncate|fchmod|fchown|futimes)/;

/** An open whose flags request writing; a read open (no flags, or "r") passes through. */
function opensForWriting(flags: unknown): boolean {
	if (typeof flags === "string") return /[wa+]/.test(flags);
	if (typeof flags === "number") return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
	return false;
}

/** The fs functions of one table (fs or fs.promises) whose name matches WRITE_NAME. */
function writeNamed(table: Table): string[] {
	return Object.keys(table).filter((name) => WRITE_NAME.test(name) && typeof table[name] === "function");
}

/**
 * While active, any call to a write API of node:fs or fs.promises throws (sync
 * forms and callback forms alike; the promise form rejects). Opens pass through
 * unless their flags write. Returns the list of attempts and the restore function.
 */
export function fsTripwire(): { calls: string[]; restore(): void } {
	const calls: string[] = [];
	const restores: Array<() => void> = [];
	const trap = (label: string, isOpen: boolean, real: Fn) => {
		return (...args: unknown[]): unknown => {
			if (isOpen && !opensForWriting(args[1])) return real(...args);
			calls.push(label);
			throw new Error(`${label} called while the read-only server was running`);
		};
	};
	for (const name of writeNamed(fs as unknown as Table)) {
		const real = (fs as unknown as Table)[name] as Fn;
		const m = mock.method(fs as unknown as Table, name, trap(name, name.startsWith("open"), real.bind(fs)));
		restores.push(() => m.mock.restore());
	}
	const promises = fs.promises as unknown as Table;
	for (const name of writeNamed(promises)) {
		const real = promises[name] as Fn;
		const label = `promises.${name}`;
		const m = mock.method(promises, name, (...args: unknown[]) => {
			if (name.startsWith("open") && !opensForWriting(args[1])) return (real as Fn)(...args);
			calls.push(label);
			return Promise.reject(new Error(`fs.${label} called while the read-only server was running`));
		});
		restores.push(() => m.mock.restore());
	}
	return { calls, restore: () => restores.reverse().forEach((r) => r()) };
}
