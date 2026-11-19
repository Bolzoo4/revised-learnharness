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

const PUBLIC_PATHS = new Set(["/healthz", "/signin", "/api/access/signin"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function parseCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return null;
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
	if (!settings.token) return { kind: "deny", status: 503 };

	const host = request.host?.toLowerCase() ?? null;
	if (!host || !settings.allowedHosts.includes(host)) return { kind: "deny", status: 421 };

	if (request.tailscaleLogin !== null && request.tailscaleLogin !== settings.tailscaleLogin) return { kind: "deny", status: 403 };

	if (!SAFE_METHODS.has(request.method) && !sameOrigin(request, host)) return { kind: "deny", status: 403 };

	if (PUBLIC_PATHS.has(request.pathname)) return { kind: "allow" };

	if (!verifySession(parseCookie(request.cookie, SESSION_COOKIE), settings.token, now)) {
		const page = (request.method === "GET" || request.method === "HEAD") && !request.pathname.startsWith("/api/");
		return page ? { kind: "redirect", to: "/signin" } : { kind: "deny", status: 401 };
	}
	return { kind: "allow" };
}
