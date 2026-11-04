// src/store/ext/format.ts
/**
 * The extension family's FORMAT STAMP: <dir>/format.json. Same doctrine as
 * upstream's graph stamp (src/store/graph-format.ts): LAZY v1 (no sidecar
 * means version 1, the first write creates it), reads never write, and a
 * stamp NEWER than this build makes reads throw so an old build never
 * misreads or rewrites data it does not understand. A corrupt sidecar reads
 * as unstamped.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../atomic-write.ts";

export const CURRENT_EXT_FORMAT_VERSION = 1;

function formatFile(dir: string): string {
	return path.join(dir, "format.json");
}

function stampedVersion(dir: string): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(formatFile(dir), "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null;
	}
}

/** READ-SIDE GUARD: throws when the data was written by a NEWER build. Never writes. */
export function assertExtFormat(dir: string): void {
	const v = stampedVersion(dir);
	if (v !== null && v > CURRENT_EXT_FORMAT_VERSION) {
		throw new Error(
			`Extension data in ${dir} is stamped with format version ${v}, but this build understands only ${CURRENT_EXT_FORMAT_VERSION}. Upgrade the app before reading it.`,
		);
	}
}

/** WRITE-SIDE STAMP: creates the directory and the sidecar on first use. */
export function ensureExtFormat(dir: string): void {
	if (stampedVersion(dir) !== null) return;
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(formatFile(dir), JSON.stringify({ version: CURRENT_EXT_FORMAT_VERSION }, null, "\t") + "\n", {
		allowInPlaceFallback: true,
	});
}
