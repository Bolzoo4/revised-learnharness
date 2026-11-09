/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings, readSettings } from "../store/settings.ts";
import { workspacePath } from "./ext/workspace.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(): FileAccessPolicy {
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	// Extension: with no explicit File access choice the agent is restricted to its own workspace folder
	// (the workspace is always allowed on top of the learner's folders). An explicit "unrestricted" choice stays.
	const explicit = readSettings()?.agent?.fileAccess !== undefined;
	const restricted = explicit ? result.settings.restricted : true;
	const folders = result.settings.folders.map((folder) => expandFolder(folder));
	return { restricted, folders: restricted ? [workspacePath(), ...folders] : folders };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
