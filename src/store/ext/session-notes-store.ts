// src/store/ext/session-notes-store.ts
/**
 * data/ext/session-notes.json: the session study notes, one map `{ [chatId]: note }`,
 * rewritten atomically on every change (a configuration-sized document, not a ledger).
 * A missing or corrupt file reads as no notes; invalid entries are dropped on read.
 */

import fs from "node:fs";
import path from "node:path";
import { parseSessionNotes, type SessionNotesStore } from "../../core/ext/session-notes.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export function createSessionNotesStore(dir: string): SessionNotesStore {
	const file = path.join(dir, "session-notes.json");
	return {
		read() {
			assertExtFormat(dir);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return {};
			}
			try {
				return parseSessionNotes(JSON.parse(raw));
			} catch {
				return {};
			}
		},
		write(notes) {
			assertExtFormat(dir);
			ensureExtFormat(dir);
			writeFileAtomicSync(file, JSON.stringify(parseSessionNotes(notes), null, "\t") + "\n", { allowInPlaceFallback: true });
		},
	};
}
