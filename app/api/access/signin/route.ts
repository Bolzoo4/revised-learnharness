import { NextResponse } from "next/server";
import { accessSettings } from "@/src/server/access/config";
import { issueSession, SESSION_COOKIE } from "@/src/server/access/session";
import { isLoopbackHost, signinLimiter, tokensMatch } from "@/src/server/access/signin";

/** Exchange the access token for a session cookie. The only place the token is accepted. */
export async function POST(request: Request) {
	const settings = accessSettings();
	if (settings.mode === "open") return NextResponse.json({ ok: true });
	if (!settings.token) return NextResponse.json({ error: "not_configured" }, { status: 503 });

	const now = Date.now();
	const limiter = signinLimiter();
	if (!limiter.allow(now)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "300" } });

	let supplied = "";
	try {
		const body = await request.json();
		if (typeof body?.token === "string") supplied = body.token;
	} catch { /* malformed body counts as a wrong token */ }

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
