// src/core/ext/study-ports.ts
/**
 * Ports of the lecture / office-hours / exercise stage (child spec 4).
 * Core codes against these types; adapters live in src/store/ext/ and the
 * composition happens in src/server/ext/. The cost gate, trust levels and
 * the source library are the verification stage's (cost-gate.ts, trust.ts,
 * sources.ts) and are not redeclared here.
 */

import type { Lecture } from "./lecture/lecture.ts";

export interface LecturesStore {
	/** Writes data/ext/lectures/<id>/lecture.json atomically. Throws on an invalid lecture. */
	save(lecture: Lecture): void;
	get(id: string): Lecture | null;
	/** Every readable lecture, by id. Unreadable or invalid files are skipped. */
	list(): Lecture[];
	/** Removes a lecture directory. No-op for an unknown id. */
	remove(id: string): void;
}

/** Reads a snapshot written by the verification stage's SnapshotStore.put (data/ext/snapshots/<sha256>.txt). */
export interface SnapshotReader {
	get(sha256: string): string | null;
}
