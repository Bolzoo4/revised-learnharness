// src/store/ext/lecture-runs-store.ts
/**
 * data/ext/lecture-runs.json: the persisted state of the lecture ingests (one
 * document, rewritten atomically on every change). A missing, unreadable or
 * corrupt file loads as empty, never a crash. A file stamped by a newer build
 * is refused on save so its data is not overwritten.
 */

import fs from "node:fs";
import path from "node:path";
import { boundRunRecords, parseRunRecords, type BookRun, type LectureRunStore } from "../../core/ext/lecture/run-record.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createLectureRunStore(extDir: string): LectureRunStore {
	const file = path.join(extDir, "lecture-runs.json");

	return {
		load(): BookRun[] {
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return [];
			}
			try {
				return parseRunRecords(JSON.parse(raw));
			} catch {
				return [];
			}
		},
		save(books: readonly BookRun[]): void {
			assertExtFormat(extDir);
			ensureExtFormat(extDir);
			const text = JSON.stringify({ version: 1, books: boundRunRecords(books) }, null, "\t") + "\n";
			writeFileAtomicSync(file, text, { allowInPlaceFallback: true });
		},
	};
}
