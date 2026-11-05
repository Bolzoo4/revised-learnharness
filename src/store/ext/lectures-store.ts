// src/store/ext/lectures-store.ts
/**
 * data/ext/lectures/<id>/lecture.json: one atomically written file per lecture
 * (a document, not an event ledger). Same stamp doctrine as the ledgers.
 */

import fs from "node:fs";
import path from "node:path";
import { isValidLectureId, parseLecture, type Lecture } from "../../core/ext/lecture/lecture.ts";
import type { LecturesStore } from "../../core/ext/study-ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createLecturesStore(extDir: string): LecturesStore {
	const root = path.join(extDir, "lectures");
	const fileOf = (id: string): string => path.join(root, id, "lecture.json");

	function get(id: string): Lecture | null {
		if (!isValidLectureId(id)) return null;
		assertExtFormat(extDir);
		try {
			return parseLecture(JSON.parse(fs.readFileSync(fileOf(id), "utf-8")));
		} catch {
			return null;
		}
	}

	return {
		save(lecture) {
			if (parseLecture(lecture) === null) throw new Error(`lectures store: ${lecture.id} is not a valid lecture`);
			assertExtFormat(extDir);
			ensureExtFormat(extDir);
			fs.mkdirSync(path.join(root, lecture.id), { recursive: true });
			writeFileAtomicSync(fileOf(lecture.id), JSON.stringify(lecture, null, "\t") + "\n", { allowInPlaceFallback: true });
		},
		get,
		list() {
			assertExtFormat(extDir);
			let names: string[];
			try {
				names = fs.readdirSync(root);
			} catch {
				return [];
			}
			return names
				.filter(isValidLectureId)
				.sort()
				.map(get)
				.filter((l): l is Lecture => l !== null);
		},
		remove(id) {
			if (!isValidLectureId(id)) return;
			fs.rmSync(path.join(root, id), { recursive: true, force: true });
		},
	};
}
