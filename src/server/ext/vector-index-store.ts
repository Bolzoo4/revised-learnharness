// src/server/ext/vector-index-store.ts
/**
 * The vector index file (REQ-search-07, 09). Reads are safe from any process
 * (the MCP server calls readVectorIndex). Writes belong to the app process only
 * (writeVectorIndex, via the atomic writer: readers see the old file or the new one).
 */

import fs from "node:fs";
import path from "node:path";

import { decodeIndex, encodeIndex, type VectorIndex } from "../../core/ext/vector-index.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";

export function vectorIndexPath(dataDir: string): string {
	return path.join(dataDir, "ext", "embeddings.bin");
}

/** The stored index, or null when the file is missing, unreadable or not a complete index. */
export function readVectorIndex(file: string): VectorIndex | null {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch {
		return null;
	}
	return decodeIndex(new Uint8Array(bytes));
}

/** Replaces the file. Throws on failure, with the previous file untouched. */
export function writeVectorIndex(file: string, index: VectorIndex): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, encodeIndex(index));
}
