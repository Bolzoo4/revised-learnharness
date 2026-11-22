// src/server/ext/vector-index-store.ts
/**
 * The vector index file (REQ-search-07, 09). Reads are safe from any process
 * (the MCP server calls readVectorIndex). Writes belong to the app process only
 * (writeVectorIndex, via the atomic writer: readers see the old file or the new one).
 */

import fs from "node:fs";
import path from "node:path";

import { encodeIndex, VECTOR_INDEX_FILE, type VectorIndex } from "../../core/ext/vector-index.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { readVectorIndexFile } from "../../store/ext/readonly.ts";

export function vectorIndexPath(dataDir: string): string {
	return path.join(dataDir, "ext", VECTOR_INDEX_FILE);
}

/** The stored index, or null when the file is missing, unreadable or not a complete index (read-only). */
export const readVectorIndex = readVectorIndexFile;

/** Replaces the file. Throws on failure, with the previous file untouched. */
export function writeVectorIndex(file: string, index: VectorIndex): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, encodeIndex(index));
}
