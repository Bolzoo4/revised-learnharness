// src/server/data-lock.ts
import fs from "node:fs";
import path from "node:path";

export class DataLockHeldError extends Error {
	constructor(readonly pid: number, readonly file: string) {
		super(`the data directory is already served by process ${pid} (${file})`);
		this.name = "DataLockHeldError";
	}
}

export interface DataLock { release(): void }
export interface LockDeps { pid: number; isAlive(pid: number): boolean }

const defaults: LockDeps = {
	pid: process.pid,
	isAlive: (pid) => {
		try { process.kill(pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
	},
};

/**
 * @pre  directory is the LH_DATA_DIR this server will read and write
 * @post at most one live process holds the lock; a lock whose pid is dead, unreadable or
 *       garbage is replaced; a pid that is alive and not ours makes this throw DataLockHeldError
 */
export function acquireDataLock(directory: string, deps: LockDeps = defaults): DataLock {
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, ".lh-server.lock");
	const mine = String(deps.pid);
	const lock: DataLock = {
		release() {
			try { if (fs.readFileSync(file, "utf8").trim() === mine) fs.unlinkSync(file); }
			catch { /* already gone */ }
		},
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600);
			fs.writeSync(fd, mine);
			fs.closeSync(fd);
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = Number.NaN;
		try { holder = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10); } catch { /* vanished: retry */ }
		if (holder === deps.pid) return lock;
		if (Number.isInteger(holder) && holder > 0 && deps.isAlive(holder)) throw new DataLockHeldError(holder, file);
		try { fs.unlinkSync(file); } catch { /* raced with another cleaner: retry */ }
	}
	throw new Error(`could not take the data lock at ${file}`);
}
