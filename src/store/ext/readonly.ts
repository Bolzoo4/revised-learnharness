// src/store/ext/readonly.ts
/**
 * THE READ-ONLY DATA LAYER of the MCP server (REQ-mcp-01, REQ-mcp-02,
 * REQ-mcp-03). Deliberately NOT built on createLedger or the ext stores: those
 * modules also hold the write side (ensureExtFormat, atomic writes), and
 * upstream's store/graph.ts even deletes legacy ledgers when it is imported.
 * This file uses exactly three fs calls (statSync, readFileSync, readdirSync)
 * and a test (ext-mcp-closure) fails if anything reachable from the server
 * contains a write API. Reading rules mirror the app's: a stamp newer than
 * this build refuses, corrupt or invalid lines are skipped, a missing file is
 * empty. Added here: a size ceiling per file (bounded parse time).
 */

import fs from "node:fs";
import path from "node:path";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../../core/contracts/graph.ts";
import type { GraphChain, GraphNode } from "../../core/contracts.ts";
import { NEWER_FORMAT_MESSAGE, ToolError } from "../../core/ext/mcp/errors.ts";
import { LIMITS } from "../../core/ext/mcp/limits.ts";
import type { LectureReader, ReadLog } from "../../core/ext/mcp/ports.ts";
import { isValidLectureId, parseLecture, type Lecture } from "../../core/ext/lecture/lecture.ts";
import type { GraphStore } from "../../core/ports.ts";

/** Same value as store/ext/format.ts CURRENT_EXT_FORMAT_VERSION (a test pins the equality). */
export const EXT_FORMAT_VERSION = 1;

/** The size of a regular file, or null when the path is missing or is not one (FIFO, device, socket, directory). */
function regularFileSize(file: string): number | null {
	try {
		const st = fs.statSync(file);
		return st.isFile() ? st.size : null;
	} catch {
		return null;
	}
}

function stampedVersion(dir: string): number | null {
	const file = path.join(dir, "format.json");
	if (regularFileSize(file) === null) return null; // a FIFO or device would block the read: such a stamp is not read
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null; // a corrupt sidecar reads as unstamped, like the app
	}
}

/** Throws ToolError(data_newer_than_build) when either stamp is newer than this build. Never writes. */
export function createReadableGuard(dataRoot: string): () => void {
	const extDir = path.join(dataRoot, "ext");
	const graphDir = path.join(dataRoot, "graph");
	return () => {
		const ext = stampedVersion(extDir);
		const graph = stampedVersion(graphDir);
		if ((ext !== null && ext > EXT_FORMAT_VERSION) || (graph !== null && graph > CURRENT_GRAPH_FORMAT_VERSION)) {
			throw new ToolError("data_newer_than_build", NEWER_FORMAT_MESSAGE);
		}
	};
}

/** Startup check: the data directory must exist. It is never created. Throws a plain Error (stderr only). */
export function validateDataRoot(dataRoot: string): void {
	let isDir = false;
	try {
		isDir = fs.statSync(dataRoot).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) throw new Error(`data directory not found: ${dataRoot} (set LH_DATA_DIR to the app's data directory)`);
}

function readJsonl<T>(file: string, label: string, parse: (raw: unknown) => T | null, maxBytes: number): T[] {
	// A FIFO or a symlink to a device (/dev/zero) would block or never end: only a regular file is a ledger.
	const size = regularFileSize(file);
	if (size === null) return [];
	if (size > maxBytes) throw new ToolError("data_too_large", `${label} is larger than this server's read limit.`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			continue; // a corrupt or torn line is skipped, never repaired
		}
		let event: T | null;
		try {
			event = parse(value);
		} catch {
			continue;
		}
		if (event !== null) out.push(event);
	}
	return out;
}

/** A ledger under <dataRoot>/ext with only a read side. */
export function readOnlyLedger<T>(
	extDir: string,
	fileName: string,
	parse: (raw: unknown) => T | null,
	maxBytes: number = LIMITS.ledgerMaxBytes,
): ReadLog<T> {
	const file = path.join(extDir, fileName);
	return { readAll: () => readJsonl(file, fileName, parse, maxBytes) };
}

// ── the content graph (shape guards mirror store/graph.ts; a test pins parity) ──

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const isPoint = (v: unknown): boolean => isRecord(v) && isString(v.chatId) && isString(v.messageId);

/** An id as the server would echo it: a string within the id bound. Longer ids are skipped, never echoed. */
const isId = (v: unknown): v is string => isString(v) && v.length <= LIMITS.idMaxChars;

const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isId(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isPoint);

const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isId(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isId) &&
	isId(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isPoint) &&
	isString(v.createdAt);

export function createGraphReader(graphDir: string, maxBytes: number = LIMITS.ledgerMaxBytes): Pick<GraphStore, "readNodes" | "readChains"> {
	return {
		readNodes: () => readJsonl(path.join(graphDir, "nodes.jsonl"), "nodes.jsonl", (v) => (isGraphNode(v) ? v : null), maxBytes),
		readChains: () => readJsonl(path.join(graphDir, "chains.jsonl"), "chains.jsonl", (v) => (isGraphChain(v) ? v : null), maxBytes),
	};
}

// ── lectures (data/ext/lectures/<id>/lecture.json) ───────────────────────────

/** Total bytes of lecture.json files one list() may read (a sum over files, so many small lectures are bounded too). */
export const LECTURE_TOTAL_BYTES_MAX = 32 * 1024 * 1024;

export function createLectureReader(extDir: string, options: { totalBytesMax?: number } = {}): LectureReader {
	const root = path.join(extDir, "lectures");
	const totalBytesMax = options.totalBytesMax ?? LECTURE_TOTAL_BYTES_MAX;
	function get(id: string): Lecture | null {
		if (!isValidLectureId(id)) return null;
		const file = path.join(root, id, "lecture.json");
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile() || stat.size > LIMITS.lectureFileMaxBytes) return null;
			const lecture = parseLecture(JSON.parse(fs.readFileSync(file, "utf-8")));
			return lecture !== null && lecture.id === id ? lecture : null; // a file under another id's directory is not that lecture
		} catch {
			return null;
		}
	}
	return {
		get,
		list() {
			let names: string[];
			try {
				names = fs.readdirSync(root);
			} catch {
				return [];
			}
			const out: Lecture[] = [];
			let total = 0;
			for (const id of names.filter(isValidLectureId).sort().slice(0, LIMITS.lectureFilesMax)) {
				const size = regularFileSize(path.join(root, id, "lecture.json"));
				if (size === null) continue;
				total += size;
				if (total > totalBytesMax) throw new ToolError("data_too_large", "The lecture files together are larger than this server's read limit.");
				const lecture = get(id);
				if (lecture !== null) out.push(lecture);
			}
			return out;
		},
	};
}
