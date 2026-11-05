// src/store/ext/sources-store.ts
import fs from "node:fs";
import path from "node:path";
import { parseSourceLibrary } from "../../core/ext/sources.ts";
import type { SourcesStore } from "../../core/ext/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

/** sources.json: `{ "entries": [...] }`, read-modify-write (a configuration file, not a ledger). */
export function createSourcesStore(dir: string): SourcesStore {
	const file = path.join(dir, "sources.json");
	return {
		read() {
			assertExtFormat(dir);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return [];
			}
			try {
				return parseSourceLibrary(JSON.parse(raw));
			} catch {
				return [];
			}
		},
		write(entries) {
			assertExtFormat(dir);
			ensureExtFormat(dir);
			writeFileAtomicSync(file, JSON.stringify({ entries }, null, "\t") + "\n", { allowInPlaceFallback: true });
		},
	};
}
