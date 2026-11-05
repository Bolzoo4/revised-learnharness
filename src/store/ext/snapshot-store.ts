// src/store/ext/snapshot-store.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SnapshotStore } from "../../core/ext/ports.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { assertExtFormat, ensureExtFormat } from "./format.ts";

/** Immutable, content-addressed: snapshots/<sha256>.txt (REQ-src-04). */
export function createSnapshotStore(dir: string): SnapshotStore {
	return {
		put(text) {
			const hash = createHash("sha256").update(text, "utf8").digest("hex");
			const file = path.join(dir, "snapshots", `${hash}.txt`);
			assertExtFormat(dir); // before the early return: a newer build's data is never read or reused
			if (fs.existsSync(file)) return hash;
			ensureExtFormat(dir);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, text, { allowInPlaceFallback: true });
			return hash;
		},
	};
}
