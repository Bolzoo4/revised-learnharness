"use strict";

/**
 * Exchange the access token for the session cookie, once per launch, and store the cookie
 * in the caller's cookie jar. The token is sent only to the sign-in endpoint of `origin`.
 * deps: { origin, token, fetch, setCookie(details) }
 */
async function signInToService({ origin, token, fetch, setCookie }) {
	const response = await fetch(`${origin}/api/access/signin`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ token }),
	});
	if (!response.ok) throw new Error(`service sign-in failed (${response.status})`);
	const raw = (response.headers.getSetCookie?.() ?? []).find((line) => line.startsWith("lh_session=")) ?? "";
	const value = /^lh_session=([^;]+)/.exec(raw)?.[1];
	if (!value) throw new Error("service sign-in returned no session");
	const expires = /expires=([^;]+)/i.exec(raw)?.[1];
	await setCookie({
		url: origin, name: "lh_session", value, httpOnly: true, sameSite: "strict",
		...(expires ? { expirationDate: Date.parse(expires) / 1000 } : {}),
	});
}

module.exports = { signInToService };
