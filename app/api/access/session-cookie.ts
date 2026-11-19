import type { NextResponse } from "next/server";
import { isLoopbackHost, issueSession, SESSION_COOKIE, sessionTtlFor } from "@/src/server";

/** Attach a fresh session cookie, Secure and 14 days off loopback (REQ-remote-04). */
export function setSessionCookie(response: NextResponse, token: string, host: string | null, now: number): void {
	const session = issueSession(token, now, sessionTtlFor(host));
	response.cookies.set({
		name: SESSION_COOKIE, value: session.value, httpOnly: true, sameSite: "strict", path: "/",
		expires: new Date(session.expires), secure: !isLoopbackHost(host),
	});
}
