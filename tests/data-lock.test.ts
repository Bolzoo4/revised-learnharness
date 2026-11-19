// tests/data-lock.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireDataLock, DataLockHeldError } from "../src/server/data-lock.ts";

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-lock-"));
const alive = (set: number[]) => (pid: number) => set.includes(pid);
const deps = (pid: number, set: number[], boot = 1_000_000) => ({ pid, isAlive: alive(set), bootTime: () => boot });

test("the first server takes the lock and writes its pid", () => {
	const dir = fresh();
	const lock = acquireDataLock(dir, deps(100, [100]));
	assert.equal(fs.readFileSync(path.join(dir, ".lh-server.lock"), "utf8"), "100 1000000");
	lock.release();
	assert(!fs.existsSync(path.join(dir, ".lh-server.lock")));
});

test("a second live server is refused with the holder's pid", () => {
	const dir = fresh();
	acquireDataLock(dir, deps(100, [100, 200]));
	assert.throws(() => acquireDataLock(dir, deps(200, [100, 200])), (error: unknown) => error instanceof DataLockHeldError && error.pid === 100);
});

test("a lock left by a dead process is taken over", () => {
	const dir = fresh();
	fs.writeFileSync(path.join(dir, ".lh-server.lock"), "999");
	const lock = acquireDataLock(dir, deps(200, [200]));
	assert.equal(fs.readFileSync(path.join(dir, ".lh-server.lock"), "utf8"), "200 1000000");
	lock.release();
});

test("a garbage lock file is treated as stale", () => {
	const dir = fresh();
	fs.writeFileSync(path.join(dir, ".lh-server.lock"), "not a pid");
	acquireDataLock(dir, deps(200, [200])).release();
});

test("the same pid asking again does not deadlock itself", () => {
	const dir = fresh();
	acquireDataLock(dir, deps(100, [100]));
	acquireDataLock(dir, deps(100, [100])).release();
});

test("release never removes another process's lock", () => {
	const dir = fresh();
	const mine = acquireDataLock(dir, deps(100, [100]));
	fs.writeFileSync(path.join(dir, ".lh-server.lock"), "300");
	mine.release();
	assert.equal(fs.readFileSync(path.join(dir, ".lh-server.lock"), "utf8"), "300");
});

test("the directory is created when missing", () => {
	const dir = path.join(fresh(), "nested", "data");
	acquireDataLock(dir, deps(1, [1])).release();
	assert(fs.existsSync(dir));
});

test("a lock written before the last reboot is stale even if its pid is alive again", () => {
	const dir = fresh();
	acquireDataLock(dir, deps(100, [100, 200], 1_000_000));
	const lock = acquireDataLock(dir, deps(200, [100, 200], 1_050_000));
	assert.equal(fs.readFileSync(path.join(dir, ".lh-server.lock"), "utf8"), "200 1050000");
	lock.release();
});

test("boot-time jitter within the tolerance does not defeat the lock", () => {
	const dir = fresh();
	acquireDataLock(dir, deps(100, [100, 200], 1_000_000));
	assert.throws(() => acquireDataLock(dir, deps(200, [100, 200], 1_000_003)), DataLockHeldError);
});

test("a recycled pid equal to ours after a reboot does not count as our own lock", () => {
	const dir = fresh();
	acquireDataLock(dir, deps(100, [100], 1_000_000));
	const lock = acquireDataLock(dir, deps(100, [100], 1_050_000));
	assert.equal(fs.readFileSync(path.join(dir, ".lh-server.lock"), "utf8"), "100 1050000");
	lock.release();
});
