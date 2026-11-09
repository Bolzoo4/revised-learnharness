// src/server/ext/workspace.ts
/**
 * The agent's own workspace: one folder inside the app's data (<data>/workspace). It is the only place the file
 * tools (read, ls, find, grep) can see by default, and everything the learner uploads or attaches is copied into
 * it, so the app keeps its own copy and never needs the original again. Folders the learner adds in Settings →
 * Agent → Tools → File access come on top of it.
 *
 * Copying in goes through the same mandatory denials as reading (credentials and other sensitive places are
 * refused whatever the policy). Folders are not copied: only single files.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { isWithin } from "../../agent/tools/file-access.ts";
import { resolveSourcePath } from "../../agent/tools/fs-shared.ts";

/** Where the workspace is (nothing is created: reading the file-access policy must not touch the disk). */
export function workspacePath(dataRoot: string = PATHS.data): string {
	return path.join(dataRoot, "workspace");
}

/** The workspace folder, created on first use (an upload). */
export function workspaceDir(dataRoot: string = PATHS.data): string {
	const dir = workspacePath(dataRoot);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Largest file copied in (bytes). */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const OPEN_POLICY = { restricted: false, folders: [], unavailable: [] } as const;

/** A file name that is safe as a single path segment. */
export function safeFileName(name: string): string {
	const base = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
	return base === "" || base === "." || base === ".." ? "file" : base.slice(0, 120);
}

/** Writes a new file <root>/<subdir>/<name> through `write`, never overwriting: a taken name gets " (2)", " (3)"... */
function writeUnique(write: (target: string) => void, subdir: string, name: string, root: string): string {
	const dir = path.join(root, subdir);
	fs.mkdirSync(dir, { recursive: true });
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let n = 1; ; n++) {
		const target = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
		try {
			write(target);
			return target;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** Keeps uploaded bytes in the workspace (e.g. an exam PDF); returns where they were kept. */
export function keepBytes(bytes: Uint8Array, subdir: string, name: string, root: string = workspaceDir()): string {
	return writeUnique((target) => fs.writeFileSync(target, bytes, { flag: "wx" }), subdir, safeFileName(name), root);
}

export interface ImportResult {
	/** One entry per input path, in order: the workspace copy, or the input itself when it is not a file we copy. */
	paths: string[];
	/** Plain-words reasons for the files that could not be copied (their input path is returned unchanged). */
	errors: string[];
}

/**
 * Copies each file path into <workspace>/uploads. A path already inside the workspace is returned as is;
 * a folder is returned as is (not copied); a refused, missing or oversized file is returned as is with a reason.
 */
export function importIntoWorkspace(inputs: readonly string[], root: string = workspaceDir()): ImportResult {
	const paths: string[] = [];
	const errors: string[] = [];
	for (const input of inputs) {
		try {
			const real = resolveSourcePath(input, OPEN_POLICY);
			const stat = fs.statSync(real);
			if (isWithin(real, fs.realpathSync(root)) || !stat.isFile()) {
				paths.push(input);
				continue;
			}
			if (stat.size > MAX_IMPORT_BYTES) {
				errors.push(`${path.basename(input)} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB and was not copied.`);
				paths.push(input);
				continue;
			}
			paths.push(writeUnique((target) => fs.copyFileSync(real, target, fs.constants.COPYFILE_EXCL), "uploads", safeFileName(real), root));
		} catch {
			errors.push(`${path.basename(input)} could not be copied (missing, unreadable or protected).`);
			paths.push(input);
		}
	}
	return { paths, errors };
}
