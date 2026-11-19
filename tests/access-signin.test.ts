// tests/access-signin.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { tokensMatch, isLoopbackHost, createFailureLimiter, sessionTtlFor } from "../src/server/access/signin.ts";
import { REMOTE_SESSION_TTL_MS, SESSION_TTL_MS } from "../src/server/access/session.ts";

test("tokensMatch accepts only the exact token", () => {
	const token = "q".repeat(64);
	assert(tokensMatch(token, token));
	for (const bad of ["", "q", token + "x", token.slice(1), "Q".repeat(64), " " + token, token + " "]) assert(!tokensMatch(bad, token), JSON.stringify(bad));
});

test("isLoopbackHost recognises only loopback hosts with a port", () => {
	assert(isLoopbackHost("127.0.0.1:47890"));
	assert(isLoopbackHost("localhost:47890"));
	assert(isLoopbackHost("LOCALHOST:1"));
	for (const bad of [null, "", "127.0.0.1", "mac.tail1234.ts.net", "127.0.0.1.evil.example:1", "evil.example:1", "localhost.evil.example:1"]) assert(!isLoopbackHost(bad), String(bad));
});

test("the limiter locks after max failures within the window and unlocks after lockMs", () => {
	const limiter = createFailureLimiter({ maxFailures: 3, windowMs: 1000, lockMs: 5000 });
	assert(limiter.allow(0));
	limiter.fail(0); limiter.fail(10);
	assert(limiter.allow(20), "two failures do not lock");
	limiter.fail(30);
	assert(!limiter.allow(31), "third failure locks");
	assert(!limiter.allow(5029));
	assert(limiter.allow(5030), "lock expires");
});

test("failures outside the window do not accumulate", () => {
	const limiter = createFailureLimiter({ maxFailures: 3, windowMs: 1000, lockMs: 5000 });
	limiter.fail(0); limiter.fail(500); limiter.fail(1600);
	assert(limiter.allow(1601));
});

test("reset clears failures and lock", () => {
	const limiter = createFailureLimiter({ maxFailures: 1, windowMs: 1000, lockMs: 5000 });
	limiter.fail(0);
	assert(!limiter.allow(1));
	limiter.reset();
	assert(limiter.allow(2));
});

test("sessions last 90 days on loopback and 14 days anywhere else", () => {
	assert.equal(sessionTtlFor("127.0.0.1:47890"), SESSION_TTL_MS);
	assert.equal(sessionTtlFor("localhost:47890"), SESSION_TTL_MS);
	for (const host of [null, "", "mac.tail1234.ts.net:8444", "127.0.0.1.evil.example:1"]) assert.equal(sessionTtlFor(host), REMOTE_SESSION_TTL_MS, String(host));
	assert.equal(REMOTE_SESSION_TTL_MS, 14 * 24 * 60 * 60 * 1000);
});
