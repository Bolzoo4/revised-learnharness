// src/core/ext/vector-index.ts
/**
 * The node vector index (REQ-search-07). Pure: no IO, no clock. The app process
 * embeds changed nodes and writes the file (src/server/ext/vector-index-store.ts);
 * the MCP process only reads it.
 *
 * Shape: one row per node, in order: id, the hash of the text that was embedded,
 * and the vector (Float32, `dim` values). The file records the model id and the
 * dimension; an index written by another model or dimension is discarded whole.
 *
 * File layout (one file, so one rename makes an update atomic):
 *   "LHVI" | uint32 LE header length | JSON header | float32 LE vectors
 * The JSON header holds {format, modelId, dim, ids, hashes}.
 */

import { createHash } from "node:crypto";

import { topK, type ScoredId } from "./embedder.ts";

export interface VectorIndex {
	modelId: string;
	dim: number;
	ids: string[];
	hashes: string[];
	/** ids.length * dim values, row by row. */
	vectors: Float32Array;
}

export interface NodeTextParts {
	name: string;
	aliases: readonly string[];
	statement: string;
}

/** The text of a node that gets embedded: name, aliases, statement, one per line. */
export function indexText(node: NodeTextParts): string {
	return [node.name, ...node.aliases, node.statement].join("\n");
}

export function textHash(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function emptyIndex(spec: { id: string; dim: number }): VectorIndex {
	return { modelId: spec.id, dim: spec.dim, ids: [], hashes: [], vectors: new Float32Array(0) };
}

/**
 * The index to update: the loaded one when its model and dimension match the
 * active spec, otherwise an empty one (a rebuild from scratch). Null (a missing
 * or unreadable file) is an empty index too.
 */
export function baseFor(spec: { id: string; dim: number }, loaded: VectorIndex | null): VectorIndex {
	if (loaded === null || loaded.modelId !== spec.id || loaded.dim !== spec.dim) return emptyIndex(spec);
	return loaded;
}

/**
 * What to embed and what to forget. `nodes` carries each live node's id and the hash of its
 * current text. A node is embedded when it is new or its hash changed; a stored id that no
 * live node has is dropped.
 */
export function planUpdate(nodes: ReadonlyArray<{ id: string; hash: string }>, index: VectorIndex): { embed: string[]; drop: string[] } {
	const stored = new Map<string, string>();
	index.ids.forEach((id, i) => stored.set(id, index.hashes[i]!));
	const live = new Set<string>();
	const embed: string[] = [];
	for (const node of nodes) {
		live.add(node.id);
		if (stored.get(node.id) !== node.hash) embed.push(node.id);
	}
	const drop = index.ids.filter((id) => !live.has(id));
	return { embed, drop };
}

export interface IndexChanges {
	/** Rows to set: an existing id is replaced in place, a new id is appended. */
	upserts: ReadonlyArray<{ id: string; hash: string; vector: Float32Array }>;
	/** Ids to remove. */
	drop: readonly string[];
}

/** A new index with the changes applied; the input is not modified. */
export function applyUpdate(index: VectorIndex, changes: IndexChanges): VectorIndex {
	const rows = new Map<string, { hash: string; vector: Float32Array }>();
	index.ids.forEach((id, i) => {
		rows.set(id, { hash: index.hashes[i]!, vector: index.vectors.subarray(i * index.dim, (i + 1) * index.dim) });
	});
	for (const id of changes.drop) rows.delete(id);
	for (const up of changes.upserts) {
		if (up.vector.length !== index.dim) {
			throw new RangeError(`vector dimension mismatch for ${up.id}: expected ${index.dim}, got ${up.vector.length}`);
		}
		rows.set(up.id, { hash: up.hash, vector: up.vector });
	}
	const ids = [...rows.keys()];
	const vectors = new Float32Array(ids.length * index.dim);
	ids.forEach((id, i) => vectors.set(rows.get(id)!.vector, i * index.dim));
	return { modelId: index.modelId, dim: index.dim, ids, hashes: ids.map((id) => rows.get(id)!.hash), vectors };
}

/** Every row ranked by cosine similarity to the query, best first (ties in row order). */
export function rankIndex(index: VectorIndex, query: ArrayLike<number>): ScoredId[] {
	const rows = index.ids.map((id, i) => ({ id, vector: index.vectors.subarray(i * index.dim, (i + 1) * index.dim) }));
	return topK(query, rows, rows.length);
}

const MAGIC = "LHVI";
const FORMAT = 1;

/** The stored bytes of an index. */
export function encodeIndex(index: VectorIndex): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify({ format: FORMAT, modelId: index.modelId, dim: index.dim, ids: index.ids, hashes: index.hashes }));
	const out = new Uint8Array(8 + header.length + index.vectors.length * 4);
	out.set(new TextEncoder().encode(MAGIC), 0);
	new DataView(out.buffer).setUint32(4, header.length, true);
	out.set(header, 8);
	const view = new DataView(out.buffer, 8 + header.length);
	for (let i = 0; i < index.vectors.length; i++) view.setFloat32(i * 4, index.vectors[i]!, true);
	return out;
}

/** The index in the bytes, or null when they are not a complete, consistent index. Never a partial one. */
export function decodeIndex(bytes: Uint8Array): VectorIndex | null {
	if (bytes.length < 8) return null;
	if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const headerLength = view.getUint32(4, true);
	if (8 + headerLength > bytes.length) return null;
	let header: unknown;
	try {
		header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
	} catch {
		return null;
	}
	if (typeof header !== "object" || header === null) return null;
	const h = header as Record<string, unknown>;
	if (h.format !== FORMAT || typeof h.modelId !== "string") return null;
	if (!Number.isInteger(h.dim) || (h.dim as number) <= 0) return null;
	const dim = h.dim as number;
	const ids = h.ids;
	const hashes = h.hashes;
	if (!Array.isArray(ids) || !Array.isArray(hashes) || ids.length !== hashes.length) return null;
	if (!ids.every((id) => typeof id === "string") || !hashes.every((x) => typeof x === "string")) return null;
	if (new Set(ids).size !== ids.length) return null;
	const count = ids.length;
	const dataStart = 8 + headerLength;
	if (bytes.length - dataStart !== count * dim * 4) return null;
	const vectors = new Float32Array(count * dim);
	for (let i = 0; i < vectors.length; i++) vectors[i] = view.getFloat32(dataStart + i * 4, true);
	return { modelId: h.modelId, dim, ids: ids as string[], hashes: hashes as string[], vectors };
}
