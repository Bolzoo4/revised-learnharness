// tests/subscription-request-origin.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionRequestOrigin } from "../src/server/web-subscription-http.ts";

const request = (url: string, host?: string) => new Request(url, host ? { headers: { host } } : {});

test("loopback hosts keep the connection's own scheme", () => {
	assert.equal(subscriptionRequestOrigin(request("http://127.0.0.1:47890/x", "127.0.0.1:47890")), "http://127.0.0.1:47890");
	assert.equal(subscriptionRequestOrigin(request("http://localhost:3000/x", "localhost:3000")), "http://localhost:3000");
});

test("a non-loopback host is https, even though Serve forwards plain http", () => {
	assert.equal(subscriptionRequestOrigin(request("http://127.0.0.1:47890/x", "mac.tail1234.ts.net:8444")), "https://mac.tail1234.ts.net:8444");
});

test("still refuses hosts that carry credentials, a path or a fragment", () => {
	for (const host of ["user@mac.ts.net:8444", "mac.ts.net:8444/x", "mac.ts.net:8444#y"]) {
		assert.equal(subscriptionRequestOrigin(request("http://127.0.0.1:47890/x", host)), undefined, host);
	}
});

test("a look-alike of a loopback host is not loopback", () => {
	assert.equal(subscriptionRequestOrigin(request("http://127.0.0.1:47890/x", "127.0.0.1.evil.example:8444")), "https://127.0.0.1.evil.example:8444");
});

test("loopback without a port keeps its scheme too", () => {
	assert.equal(subscriptionRequestOrigin(request("http://localhost/x", "localhost")), "http://localhost");
	assert.equal(subscriptionRequestOrigin(request("http://127.0.0.1/x", "127.0.0.1")), "http://127.0.0.1");
});
