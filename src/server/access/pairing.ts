import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A pairing code is good for five minutes. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

const digestOf = (code: string) => createHash("sha256").update(code).digest();

export interface PairingStore {
	create(now: number): { code: string; expiresAt: number };
	redeem(code: string, now: number): boolean;
}

/**
 * One-time pairing code, kept in memory as its SHA-256 only.
 * @post at most one code is outstanding (create replaces the previous one)
 * @post redeem(code, now) is true at most once per created code, only before expiry,
 *       and a wrong guess never consumes the real code
 */
export function createPairingStore(random: () => Buffer = () => randomBytes(16)): PairingStore {
	let current: { digest: Buffer; expiresAt: number } | null = null;
	return {
		create(now) {
			const code = random().toString("base64url");
			current = { digest: digestOf(code), expiresAt: now + PAIRING_TTL_MS };
			return { code, expiresAt: current.expiresAt };
		},
		redeem(code, now) {
			const held = current;
			if (!held) return false;
			if (now >= held.expiresAt) { current = null; return false; }
			if (!timingSafeEqual(digestOf(code), held.digest)) return false;
			current = null;
			return true;
		},
	};
}

const STORE_KEY = Symbol.for("lh.access.pairingStore");
/** One store per server process, shared by every module instance (route handlers are bundled separately). */
export function pairingStore(): PairingStore {
	const g = globalThis as typeof globalThis & { [STORE_KEY]?: PairingStore };
	return (g[STORE_KEY] ??= createPairingStore());
}
