// src/store/ext/ledger.ts
/**
 * Generic append-only JSONL event ledger for the extension layer. One line
 * per event; current state is DERIVED by the caller (store events, derive
 * state — the same doctrine as upstream's graph ledgers). A parser validates
 * every event on the way in and on the way out: the ledger never writes what
 * the parser rejects, and skips (never repairs) corrupt or invalid lines on
 * read, so a torn append cannot take the data down.
 */

import fs from "node:fs";
import path from "node:path";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

export interface Ledger<T> {
	/** Throws if the parser rejects the event or the stamp is newer than this build. */
	append(event: T): void;
	/** Never writes. [] when the file does not exist. Throws on a newer stamp. */
	readAll(): T[];
}

export function createLedger<T>(dir: string, fileName: string, parse: (raw: unknown) => T | null): Ledger<T> {
	const file = path.join(dir, fileName);
	return {
		append(event: T): void {
			assertExtFormat(dir);
			if (parse(event) === null) throw new Error(`ledger ${fileName}: event rejected by its parser`);
			ensureExtFormat(dir);
			fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
		},
		readAll(): T[] {
			assertExtFormat(dir);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				return [];
			}
			const out: T[] = [];
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				let value: unknown;
				try {
					value = JSON.parse(trimmed);
				} catch {
					continue;
				}
				const event = parse(value);
				if (event !== null) out.push(event);
			}
			return out;
		},
	};
}
