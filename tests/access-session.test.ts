// tests/access-session.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { issueSession, verifySession, SESSION_TTL_MS, SESSION_COOKIE } from "../src/server/access/session.ts";

const token = "a".repeat(64);
const other = "b".repeat(64);
const now = 1_700_000_000_000;

test("cookie name is stable", () => {
	assert.equal(SESSION_COOKIE, "lh_session");
});

test("a fresh session verifies until it expires and never after", () => {
	const { value, expires } = issueSession(token, now);
	assert.equal(expires, now + SESSION_TTL_MS);
	assert(verifySession(value, token, now));
	assert(verifySession(value, token, expires - 1));
	assert(!verifySession(value, token, expires));
	assert(!verifySession(value, token, expires + 1));
});

test("a session never verifies under another token, so rotating the token invalidates it", () => {
	const { value } = issueSession(token, now);
	assert(!verifySession(value, other, now));
});

test("tampered, truncated and malformed cookies are rejected", () => {
	const { value } = issueSession(token, now);
	const [exp, sig] = value.split(".");
	const bad: Array<string | null | undefined> = [
		null, undefined, "", ".", "x", exp, `${exp}.`, `.${sig}`,
		`${exp}.${sig}x`, `${exp}.${sig.slice(0, -1)}`,
		`${Number(exp) + 1}.${sig}`, `-1.${sig}`, `1e9.${sig}`, `${exp} .${sig}`,
		`${exp}.${sig}.${sig}`,
	];
	for (const candidate of bad) assert(!verifySession(candidate, token, now), String(candidate));
});

test("a signature made for one expiry is useless for a later one", () => {
	const a = issueSession(token, now, 1000);
	const [, sig] = a.value.split(".");
	assert(!verifySession(`${now + 9_999_999}.${sig}`, token, now));
});
