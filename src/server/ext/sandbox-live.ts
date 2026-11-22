// src/server/ext/sandbox-live.ts
/**
 * The live agent sandbox (REQ-graph-agent-22, 24): the folder <extension data>/agent-sandbox, created on demand
 * with mode 0700, and the node file-system functions the core's sandbox checks use. Only wiring; the rules are in
 * src/core/ext/sandbox.ts.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { listSandbox, resolveInSandbox, SANDBOX_DIR_NAME, SANDBOX_MAX_FILE_BYTES, type SandboxFs, type SandboxRefusal } from "../../core/ext/sandbox.ts";
import type { SandboxPort } from "./agent-goals.ts";

const PDF_MAGIC = "%PDF-";

/** The node implementation of the core's file-system functions. lstat never follows a link. */
export const liveSandboxFs: SandboxFs = {
	lstat: (absPath) => fs.lstat(absPath),
	realpath: (absPath) => fs.realpath(absPath),
	async readHead(absPath, bytes) {
		const handle = await fs.open(absPath, "r");
		try {
			const buffer = Buffer.alloc(bytes);
			const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
			return new Uint8Array(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	},
	readdir: (absPath) => fs.readdir(absPath),
};

export interface SandboxReadOptions {
	/** Bytes per read call (default 1 MiB). A test lowers it to make a read span several calls. */
	chunkBytes?: number;
	/** Called after each chunk; a test uses it to make the file grow while it is read. */
	afterChunk?: () => void;
}

/**
 * Reads one sandbox file through a single descriptor (REQ-graph-agent-24, no check-then-read by path). The file is
 * opened with O_NOFOLLOW, so a symbolic link at open time is refused (ELOOP); fstat must show a regular file of at
 * most 20 MB; the first bytes must be %PDF-; and the whole file is read from the same descriptor, with a cap one
 * byte above 20 MB, so a file that grows past the cap while it is read is refused.
 */
export async function readSandboxFile(absPath: string, options: SandboxReadOptions = {}): Promise<{ ok: true; bytes: Uint8Array } | SandboxRefusal> {
	const refuse = (reason: string): SandboxRefusal => ({ ok: false, reason });
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch {
		return refuse("cannot be opened as a regular file");
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return refuse("is not a regular file");
		if (stat.size > SANDBOX_MAX_FILE_BYTES) return refuse("is over the 20 MB limit");
		const head = await handle.read(Buffer.alloc(PDF_MAGIC.length), 0, PDF_MAGIC.length, 0);
		if (head.buffer.subarray(0, head.bytesRead).toString("latin1") !== PDF_MAGIC) return refuse("is not a PDF");
		const chunkBytes = options.chunkBytes ?? 1024 * 1024;
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const buffer = Buffer.alloc(chunkBytes);
			const { bytesRead } = await handle.read(buffer, 0, chunkBytes, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > SANDBOX_MAX_FILE_BYTES) return refuse("is over the 20 MB limit");
			chunks.push(buffer.subarray(0, bytesRead));
			options.afterChunk?.();
		}
		return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
	} catch {
		return refuse("cannot be read");
	} finally {
		await handle.close();
	}
}

/** A sandbox over the folder that `rootOf` names (a function, so a test can point it at a temp folder). */
export function createSandboxAccess(rootOf: () => string, fsPort: SandboxFs = liveSandboxFs): SandboxPort {
	const ensureRoot = (root: string) => fs.mkdir(root, { recursive: true, mode: 0o700 });
	return {
		root: rootOf,
		async list() {
			const root = rootOf();
			await ensureRoot(root);
			return listSandbox(root, fsPort);
		},
		async read(name) {
			const root = rootOf();
			await ensureRoot(root);
			const resolved = await resolveInSandbox(root, name, fsPort);
			if (!resolved.ok) return resolved;
			return readSandboxFile(resolved.path);
		},
	};
}

/** The live sandbox: <extension data>/agent-sandbox. */
export const liveSandbox: SandboxPort = createSandboxAccess(() => path.join(EXT_PATHS.dir, SANDBOX_DIR_NAME));
