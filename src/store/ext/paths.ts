// src/store/ext/paths.ts
/**
 * Paths of the extension layer's files (docs/superpowers/specs/
 * 2026-11-04-learning-platform-integration-design.md). Everything lives in
 * <data root>/ext, beside (never inside) upstream's data/graph, with its
 * own format stamp.
 */

import path from "node:path";
import { PATHS } from "../../../config.ts";

export interface ExtPaths {
	dir: string;
	format: string;
	goals: string;
}

export function extPathsFor(dataRoot: string): ExtPaths {
	const dir = path.join(dataRoot, "ext");
	return {
		dir,
		format: path.join(dir, "format.json"),
		goals: path.join(dir, "goals.jsonl"),
	};
}

/** The live paths (LH_DATA_DIR-aware, like every upstream mutable record). */
export const EXT_PATHS: ExtPaths = extPathsFor(PATHS.data);
