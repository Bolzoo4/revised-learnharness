// src/server/access/config.ts
import { readFileSync } from "node:fs";

export const MIN_TOKEN_LENGTH = 32;

export interface AccessSettings {
	/** "open" only outside production and only when no token file is configured. */
	mode: "enforced" | "open";
	/** null while enforced means the gate denies everything (fail closed). */
	token: string | null;
	/** Lower-case `Host` header values the server answers to. */
	allowedHosts: string[];
	tailscaleLogin: string | null;
}

/**
 * @post mode is "enforced" whenever NODE_ENV is "production" or a token file is configured;
 *       token is non-null only when the file was readable and at least MIN_TOKEN_LENGTH long
 */
export function readAccessSettings(
	env: Record<string, string | undefined> = process.env,
	read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AccessSettings {
	const allowedHosts = (env.LH_ACCESS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
	const tailscaleLogin = env.LH_ACCESS_TAILSCALE_LOGIN?.trim() || null;
	const file = env.LH_ACCESS_TOKEN_FILE;
	if (!file) return { mode: env.NODE_ENV === "production" ? "enforced" : "open", token: null, allowedHosts, tailscaleLogin };
	let token: string | null = null;
	try {
		const text = read(file).trim();
		token = text.length >= MIN_TOKEN_LENGTH ? text : null;
	} catch {
		token = null;
	}
	return { mode: "enforced", token, allowedHosts, tailscaleLogin };
}

let cached: AccessSettings | undefined;
/** Read once per module instance. Rotating the token restarts the service. */
export function accessSettings(): AccessSettings {
	return (cached ??= readAccessSettings());
}
