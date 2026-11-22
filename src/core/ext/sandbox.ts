// src/core/ext/sandbox.ts
/**
 * The agent sandbox (REQ-graph-agent-22, 24): the one folder whose files an agent may attach to a goal.
 * resolveInSandbox decides whether a name the agent gave is a plain PDF inside that folder; it never follows a
 * symbolic link, never leaves the real folder, and refuses by name (the reason never carries a path). listSandbox
 * is the folder's listing. Pure: the file system is injected; the live adapter is src/server/ext/sandbox-live.ts.
 */

import { page, type Page } from "./mcp/limits.ts";

export const SANDBOX_DIR_NAME = "agent-sandbox";
export const SANDBOX_MAX_FILES = 5;
export const SANDBOX_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const SANDBOX_LIST_MAX = 200;
/** Files are listed down to this many folder levels (a file in the sandbox itself is level 1). */
export const SANDBOX_LIST_DEPTH = 3;
const NAME_MAX_CHARS = 1024;
const PDF_MAGIC = "%PDF-";

export interface SandboxStat {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	size: number;
	mtimeMs: number;
}

/** The file-system functions the sandbox needs. lstat never follows a link; a missing path makes it throw. */
export interface SandboxFs {
	lstat(absPath: string): Promise<SandboxStat>;
	realpath(absPath: string): Promise<string>;
	readHead(absPath: string, bytes: number): Promise<Uint8Array>;
	readdir(absPath: string): Promise<string[]>;
}

export interface SandboxRefusal {
	ok: false;
	/** A fixed sentence about the name, with no absolute path in it. */
	reason: string;
}

export type SandboxResolution = ({ ok: true; path: string; size: number }) | SandboxRefusal;

export interface SandboxFile {
	/** Relative to the sandbox folder, with "/" between levels. */
	name: string;
	size: number;
	modifiedAt: string;
}

const refuse = (reason: string): SandboxRefusal => ({ ok: false, reason });

/** Why a name is not a relative, plain name, or null when it is one. Pure string checks, before any file system call. */
function syntaxProblem(name: unknown): string | null {
	if (typeof name !== "string") return "must be a text name";
	if (name === "") return "is empty";
	if (name.length > NAME_MAX_CHARS) return "is too long";
	if (name.includes("\0")) return "contains a NUL character";
	if (name.includes("\\")) return "contains a backslash";
	if (name.startsWith("/")) return "is an absolute path";
	if (name.endsWith("/")) return "ends in a separator";
	for (const segment of name.split("/")) {
		if (segment === "..") return "contains a parent-folder segment (..)";
		if (segment === "" || segment === ".") return "contains an empty or . segment";
	}
	return null;
}

/**
 * Decides whether `name` is a PDF inside the sandbox folder `root`. Checks, in order: the name's syntax; the .pdf
 * name; every component with lstat (missing, not a folder on the way, a symbolic link, a final entry that is not a
 * regular file); the real path inside the real folder; the size (at most 20 MB); the first bytes (%PDF-). A file
 * system error on any step is a refusal, never an exception.
 */
export async function resolveInSandbox(root: string, name: unknown, fs: SandboxFs): Promise<SandboxResolution> {
	const syntax = syntaxProblem(name);
	if (syntax !== null) return refuse(`is not a valid sandbox name: ${syntax}`);
	const relative = name as string;
	if (!relative.toLowerCase().endsWith(".pdf")) return refuse("must end in .pdf");

	const segments = relative.split("/");
	let current = root;
	for (const [index, segment] of segments.entries()) {
		current = `${current}/${segment}`;
		const last = index === segments.length - 1;
		let stat: SandboxStat;
		try {
			stat = await fs.lstat(current);
		} catch {
			return refuse("is not a file in the sandbox folder");
		}
		if (stat.isSymbolicLink()) return refuse("passes through a symbolic link, which is not allowed");
		if (!last && !stat.isDirectory()) return refuse("is not a file in the sandbox folder");
		if (last && !stat.isFile()) return refuse("is not a regular file");
		if (last) {
			let real: string;
			let realRoot: string;
			try {
				real = await fs.realpath(current);
				realRoot = await fs.realpath(root);
			} catch {
				return refuse("cannot be read");
			}
			if (!real.startsWith(`${realRoot}/`)) return refuse("is outside the sandbox folder");
			if (stat.size > SANDBOX_MAX_FILE_BYTES) return refuse("is over the 20 MB limit");
			let head: Uint8Array;
			try {
				head = await fs.readHead(current, PDF_MAGIC.length);
			} catch {
				return refuse("cannot be read");
			}
			if (new TextDecoder().decode(head) !== PDF_MAGIC) return refuse("is not a PDF");
			return { ok: true, path: real, size: stat.size };
		}
	}
	return refuse("is not a file in the sandbox folder");
}

/**
 * The files of the sandbox folder, as a page: relative names, sizes and modification times (ISO-8601). Folders are
 * walked down to SANDBOX_LIST_DEPTH levels, symbolic links are never listed or followed, and at most
 * SANDBOX_LIST_MAX entries are kept (the page says whether more existed). An unreadable folder lists as empty.
 */
export async function listSandbox(root: string, fs: SandboxFs): Promise<Page<SandboxFile>> {
	const found: SandboxFile[] = [];
	const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
		let names: string[];
		try {
			names = (await fs.readdir(dir)).sort();
		} catch {
			return;
		}
		for (const entry of names) {
			if (found.length > SANDBOX_LIST_MAX) return;
			const full = `${dir}/${entry}`;
			const relative = prefix === "" ? entry : `${prefix}/${entry}`;
			let stat: SandboxStat;
			try {
				stat = await fs.lstat(full);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isFile()) found.push({ name: relative, size: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() });
			else if (stat.isDirectory() && level < SANDBOX_LIST_DEPTH) await walk(full, relative, level + 1);
		}
	};
	await walk(root, "", 1);
	return page(found, SANDBOX_LIST_MAX);
}
