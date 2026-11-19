import { NextResponse } from "next/server";
import { accessSettings, pairingStore, readCapped, signinLimiter } from "@/src/server";
import { setSessionCookie } from "../session-cookie";

const MAX_BODY_BYTES = 1024;

/** Exchange a one-time pairing code for a session cookie. Public, but the code is single-use and rate-limited. */
export async function POST(request: Request) {
	const settings = accessSettings();
	if (settings.mode === "open" || !settings.token) return NextResponse.json({ error: "not_available" }, { status: 404 });

	let supplied = "";
	try {
		const text = await readCapped(request, MAX_BODY_BYTES);
		if (text !== null) {
			const body = JSON.parse(text);
			if (typeof body?.code === "string") supplied = body.code;
		}
	} catch { /* malformed body counts as a wrong code */ }

	// Synchronous from here on, so a parallel burst cannot pass the limiter before any guess is counted.
	const now = Date.now();
	const limiter = signinLimiter();
	if (!limiter.allow(now)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "300" } });
	if (!supplied || !pairingStore().redeem(supplied, now)) {
		limiter.fail(now);
		return NextResponse.json({ error: "invalid" }, { status: 401 });
	}
	limiter.reset();
	const response = NextResponse.json({ ok: true });
	setSessionCookie(response, settings.token, request.headers.get("host"), now);
	return response;
}
