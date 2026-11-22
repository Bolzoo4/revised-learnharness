// src/server/ext/sandbox-live.ts
/**
 * The live agent sandbox (REQ-graph-agent-22, 24): the folder <extension data>/agent-sandbox, created on demand
 * with mode 0700, and the node file-system functions the core's sandbox checks use. Only wiring; the rules are in
 * src/core/ext/sandbox.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { EXT_PATHS } from "../../store/ext/paths.ts";
import { listSandbox, resolveInSandbox, SANDBOX_DIR_NAME, type SandboxFs } from "../../core/ext/sandbox.ts";
import type { SandboxPort } from "./agent-goals.ts";

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
			return { ok: true, bytes: new Uint8Array(await fs.readFile(resolved.path)) };
		},
	};
}

/** The live sandbox: <extension data>/agent-sandbox. */
export const liveSandbox: SandboxPort = createSandboxAccess(() => path.join(EXT_PATHS.dir, SANDBOX_DIR_NAME));
