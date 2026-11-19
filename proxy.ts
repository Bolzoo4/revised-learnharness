// proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { accessSettings } from "./src/server/access/config.ts";
import { evaluateAccess } from "./src/server/access/gate.ts";

/** One gate for pages and API: host allowlist, Tailscale identity, session cookie, Origin.
 * Next runs this on the Node runtime; it keeps no state (the rate limiter lives in the
 * sign-in route handler, as the proxy docs advise against shared globals here). */
export function proxy(request: NextRequest) {
	const headers = request.headers;
	const decision = evaluateAccess(
		{
			method: request.method,
			pathname: request.nextUrl.pathname,
			host: headers.get("host"),
			origin: headers.get("origin"),
			secFetchSite: headers.get("sec-fetch-site"),
			cookie: headers.get("cookie"),
			tailscaleLogin: headers.get("tailscale-user-login"),
		},
		accessSettings(),
		Date.now(),
	);
	if (decision.kind === "allow") return NextResponse.next();
	// Absolute Location: Next's runtime rejects a relative one (ERR_INVALID_URL). Built from the
	// Host header, which the gate has already checked against the allowlist.
	if (decision.kind === "redirect") {
		const target = new URL(decision.to, `${request.nextUrl.protocol}//${headers.get("host") ?? request.nextUrl.host}`);
		return new NextResponse(null, { status: 307, headers: { location: target.toString(), "Cache-Control": "no-store" } });
	}
	const error = decision.status === 421 ? "Misdirected request" : decision.status === 503 ? "Access is not configured" : "Access denied";
	return NextResponse.json({ error }, { status: decision.status, headers: { "Cache-Control": "no-store" } });
}

// Anchored on purpose: only the framework's static files are skipped, not look-alikes.
export const config = { matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$).*)"] };
