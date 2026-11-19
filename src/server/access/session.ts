// src/server/access/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "lh_session";
/** 90 days. The cookie is the only credential after sign-in. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function sign(token: string, expires: number): string {
	return createHmac("sha256", token).update(`lh-session-v1:${expires}`).digest("base64url");
}

/**
 * @pre  token is the access token (length already validated by config.ts)
 * @post the returned value verifies under `token` for every instant before `expires`,
 *       and under no other token; it carries no secret beyond its own signature
 */
export function issueSession(token: string, now: number, ttlMs: number = SESSION_TTL_MS): { value: string; expires: number } {
	const expires = now + ttlMs;
	return { value: `${expires}.${sign(token, expires)}`, expires };
}

/**
 * @post false for anything that is not `<digits>.<signature>` made with `token`
 *       and not yet expired; comparison of the signature is constant-time
 */
export function verifySession(value: string | null | undefined, token: string, now: number): boolean {
	if (!value) return false;
	const dot = value.indexOf(".");
	if (dot < 1) return false;
	const expiresText = value.slice(0, dot);
	if (!/^\d{1,15}$/.test(expiresText)) return false;
	const expires = Number(expiresText);
	if (expires <= now) return false;
	const expected = Buffer.from(sign(token, expires));
	const actual = Buffer.from(value.slice(dot + 1));
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
