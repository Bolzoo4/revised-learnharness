// src/store/ext/snapshot-reader.ts
/** Read side of data/ext/snapshots/<sha256>.txt (the write side is snapshot-store.ts). */

import fs from "node:fs";
import path from "node:path";
import type { SnapshotReader } from "../../core/ext/study-ports.ts";
import { assertExtFormat } from "./format.ts";

const HASH_RE = /^[0-9a-f]{64}$/;

export function createSnapshotReader(dir: string): SnapshotReader {
	return {
		get(sha256) {
			if (!HASH_RE.test(sha256)) return null;
			assertExtFormat(dir);
			try {
				return fs.readFileSync(path.join(dir, "snapshots", `${sha256}.txt`), "utf-8");
			} catch {
				return null;
			}
		},
	};
}
