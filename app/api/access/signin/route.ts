import { NextResponse } from "next/server";
import { accessSettings } from "@/src/server/access/config";
import { issueSession, SESSION_COOKIE } from "@/src/server/access/session";
import { isLoopbackHost, signinLimiter, tokensMatch } from "@/src/server/access/signin";

const MAX_BODY_BYTES = 1024;

/** Exchange the access token for a session cookie. The only place the token is accepted. */
export async function POST(request: Request) {
	const settings = accessSettings();
	if (settings.mode === "open") return NextResponse.json({ ok: true });
	if (!settings.token) return NextResponse.json({ error: "not_configured" }, { status: 503 });

	// A token is short: refuse big bodies before reading them.
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
	let supplied = "";
	try {
		const text = await request.text();
		if (text.length <= MAX_BODY_BYTES) {
			const body = JSON.parse(text);
			if (typeof body?.token === "string") supplied = body.token;
		}
	} catch { /* malformed body counts as a wrong token */ }

	// Everything below is synchronous: with no await between the limiter check and recording
	// the failure, a parallel burst cannot pass the check before any guess is counted.
	const now = Date.now();
	const limiter = signinLimiter();
	if (!limiter.allow(now)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "300" } });

	if (!supplied || !tokensMatch(supplied, settings.token)) {
		limiter.fail(now);
		return NextResponse.json({ error: "invalid" }, { status: 401 });
	}

	limiter.reset();
	const session = issueSession(settings.token, now);
	const response = NextResponse.json({ ok: true });
	response.cookies.set({
		name: SESSION_COOKIE, value: session.value, httpOnly: true, sameSite: "strict", path: "/",
		expires: new Date(session.expires), secure: !isLoopbackHost(request.headers.get("host")),
	});
	return response;
}
