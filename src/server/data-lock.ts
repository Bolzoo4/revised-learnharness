// src/server/data-lock.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class DataLockHeldError extends Error {
	constructor(readonly pid: number, readonly file: string) {
		super(`the data directory is already served by process ${pid} (${file})`);
		this.name = "DataLockHeldError";
	}
}

export interface DataLock { release(): void }
export interface LockDeps {
	pid: number;
	isAlive(pid: number): boolean;
	/** Seconds since the epoch at which this machine booted (approximate). */
	bootTime(): number;
}

const defaults: LockDeps = {
	pid: process.pid,
	isAlive: (pid) => {
		try { process.kill(pid, 0); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
	},
	bootTime: () => Math.round(Date.now() / 1000 - os.uptime()),
};

/** The boot time derived from uptime drifts by a second or two; a reboot moves it by minutes. */
const BOOT_TOLERANCE_SECONDS = 120;

function parseLock(text: string): { pid: number; boot: number | null } {
	const [pidText = "", bootText] = text.trim().split(/\s+/);
	const boot = bootText === undefined ? null : Number.parseInt(bootText, 10);
	return { pid: Number.parseInt(pidText, 10), boot: boot !== null && Number.isInteger(boot) ? boot : null };
}

/**
 * @pre  directory is the LH_DATA_DIR this server will read and write
 * @post at most one live process holds the lock; a lock whose pid is dead, unreadable or
 *       garbage, or that was written before the last reboot (a recycled pid), is replaced;
 *       a pid that is alive, from this boot and not ours makes this throw DataLockHeldError
 */
export function acquireDataLock(directory: string, deps: LockDeps = defaults): DataLock {
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, ".lh-server.lock");
	const mine = String(deps.pid);
	const lock: DataLock = {
		release() {
			try { if (parseLock(fs.readFileSync(file, "utf8")).pid === deps.pid) fs.unlinkSync(file); }
			catch { /* already gone */ }
		},
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600);
			fs.writeSync(fd, `${mine} ${deps.bootTime()}`);
			fs.closeSync(fd);
			return lock;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = { pid: Number.NaN, boot: null as number | null };
		try { holder = parseLock(fs.readFileSync(file, "utf8")); } catch { /* vanished: retry */ }
		const sameBoot = holder.boot === null || Math.abs(holder.boot - deps.bootTime()) <= BOOT_TOLERANCE_SECONDS;
		if (sameBoot && holder.pid === deps.pid) return lock;
		if (sameBoot && Number.isInteger(holder.pid) && holder.pid > 0 && deps.isAlive(holder.pid)) throw new DataLockHeldError(holder.pid, file);
		try { fs.unlinkSync(file); } catch { /* raced with another cleaner: retry */ }
	}
	throw new Error(`could not take the data lock at ${file}`);
}
