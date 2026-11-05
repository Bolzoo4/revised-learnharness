// tests/ext-research-store.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { sourceFilePath } from "../src/core/ext/inbox.ts";
import type { CycleLogEntry } from "../src/core/ext/research-log.ts";
import { createSnapshotReader } from "../src/store/ext/snapshot-reader.ts";
import { createResearchStore, MAX_SNAPSHOT_BYTES } from "../src/store/ext/research-store.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-res-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cycle(cycleId: string, costUsd = 0): CycleLogEntry {
	return {
		type: "cycle",
		cycleId,
		trigger: "manual",
		startedAt: "2026-11-04T10:00:00.000Z",
		endedAt: "2026-11-04T10:05:00.000Z",
		stoppedBy: "completed",
		gaps: [],
		watch: { entries: 0, items: 0, ingested: 0, inbox: 0 },
		nodesAdded: 0,
		costUsd,
		steers: [],
	};
}

function listAll(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const n of fs.readdirSync(d)) {
			const p = path.join(d, n);
			if (fs.statSync(p).isDirectory()) walk(p);
			else out.push(path.relative(dir, p));
		}
	};
	walk(dir);
	return out.sort();
}

describe("research store", () => {
	it("ledgers append valid events, refuse invalid ones, and skip corrupt lines", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		assert.deepEqual(s.inbox.readAll(), []);
		s.inbox.append({ type: "decided", locator: "https://a.org", decision: "rejected", at: "t" });
		assert.throws(() => s.inbox.append({ type: "decided", locator: "", decision: "rejected", at: "t" }));
		fs.appendFileSync(path.join(dir, "inbox.jsonl"), "{ torn\n");
		assert.equal(createResearchStore(dir).inbox.readAll().length, 1);
		s.frontier.append({ type: "clear", markId: "m1", author: "user", at: "2026-11-04T10:00:00.000Z" });
		assert.throws(() => s.frontier.append({ type: "clear", markId: "m1", author: "user", at: "t" }), "unparseable date");
		assert.equal(s.frontier.readAll().length, 1);
	});

	it("each ledger uses its own file and the real parser (append throws on invalid, read skips invalid lines)", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		assert.throws(() => s.frontier.append({ type: "nope" } as never));
		assert.throws(() => s.log.append({ type: "cycle", cycleId: "" } as never));
		assert.throws(() => s.radar.append({ type: "nope" } as never));
		assert.throws(() => s.inbox.append({ type: "nope" } as never));
		s.log.append(cycle("c1"));
		s.radar.append({ type: "checked", entryId: "w1", ok: true, items: 2, at: "2026-11-04T10:00:00.000Z" });
		fs.appendFileSync(path.join(dir, "research-log.jsonl"), `${JSON.stringify({ type: "cycle", cycleId: "bad" })}\n`);
		fs.appendFileSync(path.join(dir, "radar.jsonl"), `${JSON.stringify({ type: "zzz" })}\n`);
		assert.deepEqual(s.log.readAll().map((e) => e.cycleId), ["c1"]);
		assert.ok(fs.existsSync(path.join(dir, "research-log.jsonl")));
		assert.ok(fs.existsSync(path.join(dir, "radar.jsonl")));
		assert.equal(fs.existsSync(path.join(dir, "frontier.jsonl")), false, "refused appends write nothing");
	});

	it("the log keeps the FIRST entry of a duplicate cycleId on read", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		s.log.append(cycle("c1", 1));
		s.log.append(cycle("c2", 2));
		s.log.append(cycle("c1", 99));
		assert.deepEqual(s.log.readAll().map((e) => [e.cycleId, e.costUsd]), [["c1", 1], ["c2", 2]]);
		// still the same after a re-open
		assert.deepEqual(createResearchStore(dir).log.readAll().map((e) => e.costUsd), [1, 2]);
	});

	it("exposes stable ledger objects and a lockKey identifying the data dir", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		assert.equal(s.log, s.log);
		assert.equal(s.inbox, s.inbox);
		assert.equal(s.frontier, s.frontier);
		assert.equal(s.radar, s.radar);
		assert.equal(s.watchlist, s.watchlist);
		assert.equal(s.snapshots, s.snapshots);
		assert.equal(s.lockKey, path.resolve(dir));
		assert.equal(s.lockKey, createResearchStore(`${dir}${path.sep}..${path.sep}${path.basename(dir)}`).lockKey);
		assert.notEqual(s.lockKey, createResearchStore(tmp()).lockKey);
		assert.notEqual(s.log, createResearchStore(dir).log);
	});

	it("reads never create files, the directory or the format stamp", () => {
		const dir = path.join(tmp(), "ext");
		const s = createResearchStore(dir);
		s.frontier.readAll();
		s.log.readAll();
		s.inbox.readAll();
		s.radar.readAll();
		s.watchlist.read();
		assert.equal(fs.existsSync(dir), false);
	});

	it("a newer format stamp makes every read and write throw", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify({ version: 99 }));
		const s = createResearchStore(dir);
		assert.throws(() => s.frontier.readAll(), /format version 99/);
		assert.throws(() => s.log.readAll(), /format version 99/);
		assert.throws(() => s.inbox.readAll(), /format version 99/);
		assert.throws(() => s.radar.readAll(), /format version 99/);
		assert.throws(() => s.watchlist.read(), /format version 99/);
		assert.throws(() => s.watchlist.write([]), /format version 99/);
		assert.throws(() => s.snapshots.put("text"), /format version 99/);
		assert.deepEqual(listAll(dir), ["format.json"]);
	});

	it("watchlist round-trips, drops invalid entries and reads [] when absent or corrupt", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		assert.deepEqual(s.watchlist.read(), []);
		s.watchlist.write([{ id: "w1", kind: "arxiv-query", query: "gradients", cadenceHours: 24 }]);
		assert.equal(createResearchStore(dir).watchlist.read()[0]?.id, "w1");
		fs.writeFileSync(path.join(dir, "watchlist.json"), "{ nope");
		assert.deepEqual(s.watchlist.read(), []);
	});

	it("watchlist read drops invalid and duplicate-id entries from a hand-edited file", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		fs.writeFileSync(
			path.join(dir, "watchlist.json"),
			JSON.stringify({
				entries: [
					{ id: "a", kind: "arxiv-query", query: "q1", cadenceHours: 6 },
					{ id: "a", kind: "arxiv-query", query: "q2", cadenceHours: 6 },
					{ id: "", kind: "arxiv-query", query: "q3" },
					{ id: "b", kind: "bogus", query: "q" },
				],
			}),
		);
		assert.deepEqual(s.watchlist.read().map((e) => e.query), ["q1"]);
		fs.writeFileSync(path.join(dir, "watchlist.json"), JSON.stringify([{ id: "a", kind: "arxiv-query", query: "q" }]));
		assert.deepEqual(s.watchlist.read(), [], "a bare array is not the document shape");
	});

	it("watchlist write refuses invalid or duplicate entries instead of silently losing them, and writes nothing", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const ok = { id: "w1", kind: "arxiv-query" as const, query: "gradients", cadenceHours: 24 };
		assert.throws(() => s.watchlist.write([ok, { ...ok, id: "" }]), /invalid entry/);
		assert.throws(() => s.watchlist.write([ok, { ...ok }]), /duplicate/);
		assert.throws(() => s.watchlist.write([{ ...ok, cadenceHours: Number.NaN }]));
		assert.throws(() => s.watchlist.write([{ ...ok, kind: "nope" as never }]));
		assert.equal(fs.existsSync(path.join(dir, "watchlist.json")), false);
		s.watchlist.write([ok]);
		assert.throws(() => s.watchlist.write([ok, { ...ok, id: "" }]));
		assert.equal(s.watchlist.read().length, 1, "the previous file survives a refused write");
	});

	it("watchlist write goes through a temp file renamed over the target", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const rename = mock.method(fs, "renameSync");
		try {
			s.watchlist.write([{ id: "w1", kind: "arxiv-query", query: "a", cadenceHours: 1 }]);
		} finally {
			rename.mock.restore();
		}
		const targets = rename.mock.calls.map((c) => String(c.arguments[1]));
		assert.ok(targets.includes(path.join(dir, "watchlist.json")), targets.join(","));
	});

	it("watchlist write is atomic (no temp left) and replaces the whole list", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		s.watchlist.write([{ id: "w1", kind: "arxiv-query", query: "a", cadenceHours: 1 }]);
		s.watchlist.write([{ id: "w2", kind: "arxiv-query", query: "b", cadenceHours: 1 }]);
		assert.deepEqual(s.watchlist.read().map((e) => e.id), ["w2"]);
		assert.deepEqual(listAll(dir), ["format.json", "watchlist.json"]);
		s.watchlist.write([]);
		assert.deepEqual(s.watchlist.read(), []);
	});
});

describe("research store snapshots", () => {
	it("put stores content-addressed text that the snapshot reader reads back", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const text = "A source text, with unicode: è中文.";
		const hash = s.snapshots.put(text);
		assert.equal(hash, createHash("sha256").update(text, "utf8").digest("hex"));
		assert.equal(createSnapshotReader(dir).get(hash), text);
		assert.equal(s.snapshots.put(text), hash, "idempotent");
		assert.deepEqual(listAll(dir), ["format.json", `snapshots/${hash}.txt`]);
	});

	it("refuses empty, blank and non-string text and writes nothing", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		assert.throws(() => s.snapshots.put(""));
		assert.throws(() => s.snapshots.put("  \n\t "));
		assert.throws(() => s.snapshots.put(undefined as never));
		assert.throws(() => s.snapshots.put(42 as never));
		assert.equal(fs.readdirSync(dir).length, 0);
	});

	it("caps the size in bytes (not characters): at the cap is stored, one byte over is refused", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const atCap = "a".repeat(MAX_SNAPSHOT_BYTES);
		const hash = s.snapshots.put(atCap);
		assert.equal(fs.statSync(path.join(dir, "snapshots", `${hash}.txt`)).size, MAX_SNAPSHOT_BYTES);
		assert.throws(() => s.snapshots.put(atCap + "a"), /too large|cap|exceed/i);
		// multi-byte characters count by their UTF-8 size
		const wide = "è".repeat(MAX_SNAPSHOT_BYTES / 2 + 1);
		assert.ok(wide.length < MAX_SNAPSHOT_BYTES);
		assert.throws(() => s.snapshots.put(wide), /too large|cap|exceed/i);
		assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 1);
	});

	it("a refused snapshot creates nothing, not even the stamp", () => {
		const dir = path.join(tmp(), "ext");
		const s = createResearchStore(dir);
		assert.throws(() => s.snapshots.put("x".repeat(MAX_SNAPSHOT_BYTES + 1)));
		assert.throws(() => s.snapshots.put(""));
		assert.equal(fs.existsSync(dir), false);
	});

	it("path traversal is impossible: file names are hashes whatever the text says", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const hostile = ["../../etc/passwd", "/etc/passwd", "..\\..\\windows\\system32", "snapshots/../../x"];
		for (const text of hostile) {
			const hash = s.snapshots.put(`locator: ${text}\n${text}`);
			assert.match(hash, /^[0-9a-f]{64}$/);
		}
		const files = listAll(dir);
		assert.equal(files.length, hostile.length + 1);
		for (const f of files) assert.ok(f === "format.json" || /^snapshots\/[0-9a-f]{64}\.txt$/.test(f), f);
		assert.equal(fs.existsSync(path.join(dir, "..", "..", "etc")), false);
		assert.equal(createSnapshotReader(dir).get("../../etc/passwd"), null);
	});

	it("source file paths of hostile locators stay relative, inside research/, and distinct", () => {
		const seen = new Set<string>();
		for (const loc of ["../../etc/passwd", "/etc/passwd", "https://evil.org/../../x", "https://a.org/..%2f..%2fx", "file:///etc/passwd", "..", "\\\\host\\share", "https://a.org/a b", "https://a.org/a-b"]) {
			const p = sourceFilePath(loc);
			assert.match(p, /^research\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+-[0-9a-f]{8}\.md$/, `${loc} -> ${p}`);
			assert.equal(p.split("/").includes(".."), false);
			assert.equal(seen.has(p), false, `collision for ${loc}`);
			seen.add(p);
		}
	});

	it("leaves no temp files and no executable or world-writable bits", () => {
		const dir = tmp();
		const s = createResearchStore(dir);
		const hash = s.snapshots.put("hello");
		assert.deepEqual(listAll(dir), ["format.json", `snapshots/${hash}.txt`]);
		const mode = fs.statSync(path.join(dir, "snapshots", `${hash}.txt`)).mode;
		assert.equal(mode & 0o111, 0);
		assert.equal(mode & 0o002, 0);
	});
});
