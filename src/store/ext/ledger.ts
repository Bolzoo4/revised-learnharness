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

/** True when the file is non-empty and its last byte is not "\n": a crash left a partial line behind. */
function endsMidLine(file: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return false;
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		fs.readSync(fd, last, 0, 1, size - 1);
		return last[0] !== 0x0a;
	} finally {
		fs.closeSync(fd);
	}
}

export function createLedger<T>(dir: string, fileName: string, parse: (raw: unknown) => T | null): Ledger<T> {
	const file = path.join(dir, fileName);
	return {
		append(event: T): void {
			assertExtFormat(dir);
			if (parse(event) === null) throw new Error(`ledger ${fileName}: event rejected by its parser`);
			ensureExtFormat(dir);
			// A torn tail must end its line before the new event starts one, or the new event is lost with it.
			const sep = endsMidLine(file) ? "\n" : "";
			fs.appendFileSync(file, `${sep}${JSON.stringify(event)}\n`, "utf-8");
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
