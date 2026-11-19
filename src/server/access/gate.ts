// src/server/access/gate.ts
import type { AccessSettings } from "./config.ts";
import { SESSION_COOKIE, verifySession } from "./session.ts";

export interface GateRequest {
	method: string;
	pathname: string;
	host: string | null;
	origin: string | null;
	secFetchSite: string | null;
	cookie: string | null;
	/** Value of the `Tailscale-User-Login` header, null when absent. */
	tailscaleLogin: string | null;
}

export type GateDecision =
	| { kind: "allow" }
	| { kind: "redirect"; to: "/signin" }
	| { kind: "deny"; status: 401 | 403 | 421 | 503 };

/** Public paths and the only methods each one answers without a session. */
const PUBLIC_PATHS = new Map<string, ReadonlySet<string>>([
	["/healthz", new Set(["GET", "HEAD"])],
	["/signin", new Set(["GET", "HEAD"])],
	["/api/access/signin", new Set(["POST"])],
	["/pair", new Set(["GET", "HEAD"])],
	["/api/access/pair", new Set(["POST"])],
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Every value of cookie `name`, in order: a planted duplicate must not hide a valid session. */
export function parseCookies(header: string | null, name: string): string[] {
	if (!header) return [];
	const values: string[] = [];
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim());
	}
	return values;
}

export function parseCookie(header: string | null, name: string): string | null {
	return parseCookies(header, name)[0] ?? null;
}

function sameOrigin(request: GateRequest, host: string): boolean {
	if (request.secFetchSite !== null && request.secFetchSite !== "same-origin" && request.secFetchSite !== "none") return false;
	if (!request.origin) return false;
	try {
		return new URL(request.origin).host.toLowerCase() === host;
	} catch {
		return false;
	}
}

/**
 * The single access decision. Pure: no I/O, no clock besides `now`.
 *
 * @post "allow" is returned only when ALL hold:
 *   - settings.mode is "open", OR (a token exists AND host is allowed AND the Tailscale
 *     identity rule passes AND (the path is public OR the session cookie verifies)
 *     AND (the method is safe OR Origin is same-origin))
 * @post with mode "enforced" and no token, every request is denied (503)
 */
export function evaluateAccess(request: GateRequest, settings: AccessSettings, now: number): GateDecision {
	if (settings.mode === "open") return { kind: "allow" };
	const token = settings.token;
	if (!token) return { kind: "deny", status: 503 };

	const host = request.host?.toLowerCase() ?? null;
	if (!host || !settings.allowedHosts.includes(host)) return { kind: "deny", status: 421 };

	if (request.tailscaleLogin !== null && request.tailscaleLogin !== settings.tailscaleLogin) return { kind: "deny", status: 403 };

	const method = request.method.toUpperCase();
	if (!SAFE_METHODS.has(method) && !sameOrigin(request, host)) return { kind: "deny", status: 403 };

	if (PUBLIC_PATHS.get(request.pathname)?.has(method)) return { kind: "allow" };

	if (!parseCookies(request.cookie, SESSION_COOKIE).some((value) => verifySession(value, token, now))) {
		const page = (method === "GET" || method === "HEAD") && !request.pathname.startsWith("/api/");
		return page ? { kind: "redirect", to: "/signin" } : { kind: "deny", status: 401 };
	}
	return { kind: "allow" };
}
