// src/server/access/signin.ts
import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time comparison independent of the supplied length. */
export function tokensMatch(supplied: string, token: string): boolean {
	const a = createHash("sha256").update(supplied).digest();
	const b = createHash("sha256").update(token).digest();
	return timingSafeEqual(a, b);
}

/** True for `127.0.0.1:<port>` and `localhost:<port>`; used to decide the cookie `Secure` flag. */
export function isLoopbackHost(host: string | null): boolean {
	if (!host) return false;
	return /^(127\.0\.0\.1|localhost):\d{1,5}$/i.test(host);
}

export interface FailureLimiter {
	allow(now: number): boolean;
	fail(now: number): void;
	reset(): void;
}

/**
 * Global (not per-source) limiter: behind Tailscale Serve every request comes from loopback.
 * @post after `maxFailures` failures within `windowMs`, allow() is false for `lockMs`
 */
export function createFailureLimiter(options: { maxFailures: number; windowMs: number; lockMs: number }): FailureLimiter {
	let failures: number[] = [];
	let lockedUntil = 0;
	return {
		allow: (now) => now >= lockedUntil,
		fail(now) {
			failures = failures.filter((t) => now - t < options.windowMs);
			failures.push(now);
			if (failures.length >= options.maxFailures) {
				lockedUntil = now + options.lockMs;
				failures = [];
			}
		},
		reset() {
			failures = [];
			lockedUntil = 0;
		},
	};
}

const LIMITER_KEY = Symbol.for("lh.access.signinLimiter");
/** One limiter per server process, shared by every module instance. */
export function signinLimiter(): FailureLimiter {
	const g = globalThis as typeof globalThis & { [LIMITER_KEY]?: FailureLimiter };
	return (g[LIMITER_KEY] ??= createFailureLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 5 * 60_000 }));
}
