// tests/ext-mcp-app-api.test.ts
/**
 * The live AppApiPort (REQ-graph-agent-16): cookie sign-in with the access token,
 * cookie and Host/Origin on every call, one re-sign-in on 401, the app's error text
 * verbatim, the 30 s timeout, and the fixed "not running or not paired" text. A fake
 * fetch stands in for the app.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import { createAppApi, NOT_RUNNING_MESSAGE } from "../src/server/ext/mcp/app-api.ts";

const TOKEN = "t".repeat(40);
const PORT = 47890;

interface Req {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	hasSignal: boolean;
}

type Handler = (req: Req) => Response | Promise<Response> | never;

/** A fake fetch: records every request, answers from `handle` in order of URL. */
function fakeFetch(handle: Handler): { fetch: typeof fetch; reqs: Req[] } {
	const reqs: Req[] = [];
	const fake = async (input: string | URL | Request, init?: RequestInit) => {
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
		const req: Req = {
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			hasSignal: init?.signal !== undefined && init?.signal !== null,
		};
		reqs.push(req);
		return handle(req);
	};
	return { fetch: fake as unknown as typeof fetch, reqs };
}

const signinOk = (cookie: string) =>
	new Response("{}", { status: 200, headers: { "content-type": "application/json", "set-cookie": `lh_session=${cookie}; Path=/; HttpOnly; SameSite=Lax` } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function api(overrides: Partial<Parameters<typeof createAppApi>[0]> = {}, fetchImpl: typeof fetch) {
	return createAppApi({ tokenFile: "/unused/token", allowedHosts: `127.0.0.1:${PORT}`, readFile: () => TOKEN, fetch: fetchImpl, timeoutMs: 30_000, ...overrides });
}

async function failure(p: Promise<unknown>): Promise<ToolError> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof ToolError, `expected a ToolError, got ${String(e)}`);
		return e;
	}
	assert.fail("expected a failure");
}

describe("sign-in and calls (REQ-graph-agent-16)", () => {
	it("signs in with the token, then calls with the cookie, Host and Origin; the cookie is reused", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("cookie-1") : json(200, { goalId: "goal_1", nodeIds: [] })));
		const port = api({}, f.fetch);
		const first = await port.post("/api/ext/agent/goals", { title: "T" });
		assert.deepEqual(first, { goalId: "goal_1", nodeIds: [] });
		await port.post("/api/ext/agent/links", { from: "a", to: "b", linkType: "analogy" });

		assert.equal(f.reqs.length, 3, "one sign-in, then two calls");
		const [signin, call1, call2] = f.reqs as [Req, Req, Req];
		assert.equal(signin!.url, `http://127.0.0.1:${PORT}/api/access/signin`);
		assert.equal(signin!.method, "POST");
		assert.deepEqual(signin!.body, { token: TOKEN });
		assert.equal(signin!.headers.host, `127.0.0.1:${PORT}`);
		assert.equal(signin!.headers.origin, `http://127.0.0.1:${PORT}`);
		for (const c of [call1!, call2!]) {
			assert.equal(c.headers.cookie, "lh_session=cookie-1");
			assert.equal(c.headers.host, `127.0.0.1:${PORT}`);
			assert.equal(c.headers.origin, `http://127.0.0.1:${PORT}`);
			assert.equal(c.hasSignal, true, "every call has a timeout signal");
		}
		assert.equal(call1!.url, `http://127.0.0.1:${PORT}/api/ext/agent/goals`);
		assert.equal(call1!.method, "POST");
		assert.deepEqual(call1!.body, { title: "T" });
	});

	it("on a 401 it signs in again once and retries the call", async () => {
		let signins = 0;
		const f = fakeFetch((req) => {
			if (req.url.endsWith("/api/access/signin")) {
				signins += 1;
				return signinOk(`cookie-${signins}`);
			}
			return req.headers.cookie === "lh_session=cookie-1" ? json(401, { error: "sign in again" }) : json(200, { ok: true });
		});
		const port = api({}, f.fetch);
		assert.deepEqual(await port.put("/api/ext/agent/goals/g/weights", { chain: 1 }), { ok: true });
		assert.equal(signins, 2);
		assert.equal(f.reqs.filter((r) => r.url.includes("/weights")).length, 2);
	});

	it("a second 401 after the re-sign-in is the app's own text, with no further retry", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(401, { error: "not signed in" })));
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.message, "not signed in");
		assert.equal(f.reqs.filter((r) => r.url.endsWith("/api/access/signin")).length, 2);
		assert.equal(f.reqs.filter((r) => r.url.endsWith("/api/ext/agent/goals")).length, 2);
	});

	it("a 429 from the app is surfaced verbatim as a tool error", async () => {
		const text = "the daily spending ceiling for agent work is reached; try again tomorrow";
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(429, { error: text })));
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.message, text);
	});

	it("a 400 with a plain-text body is surfaced as that text", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : new Response("targets must contain at least one statement", { status: 400 })));
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.message, "targets must contain at least one statement");
	});

	it("uses the port of LH_ACCESS_ALLOWED_HOSTS, and 47890 when none is listed", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(200, {})));
		await api({ allowedHosts: `localhost:50001,127.0.0.1:50002` }, f.fetch).post("/api/ext/agent/links", {});
		assert.equal(f.reqs[0]!.url, "http://127.0.0.1:50002/api/access/signin");
		assert.equal(f.reqs[0]!.headers.host, "127.0.0.1:50002");
		const g = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(200, {})));
		await api({ allowedHosts: undefined }, g.fetch).post("/api/ext/agent/links", {});
		assert.equal(g.reqs[0]!.url, `http://127.0.0.1:${PORT}/api/access/signin`);
	});
});

describe("GET through the same client (REQ-graph-agent-22)", () => {
	it("signs in, then GETs with the cookie, Host and Origin and no body, and answers the JSON", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("cookie-g") : json(200, { path: "/x", files: { items: [], count: 0, truncated: false } })));
		const answer = await api({}, f.fetch).get("/api/ext/agent/sandbox");
		assert.deepEqual(answer, { path: "/x", files: { items: [], count: 0, truncated: false } });
		const call = f.reqs[1]!;
		assert.equal(call.method, "GET");
		assert.equal(call.url, `http://127.0.0.1:${PORT}/api/ext/agent/sandbox`);
		assert.equal(call.headers.cookie, "lh_session=cookie-g");
		assert.equal(call.body, undefined);
	});

	it("maps the app's error text verbatim, as the other methods do", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(500, { error: "the sandbox cannot be listed" })));
		const err = await failure(api({}, f.fetch).get("/api/ext/agent/sandbox"));
		assert.equal(err.message, "the sandbox cannot be listed");
	});
});

describe("the app is not reachable (REQ-graph-agent-16)", () => {
	it("a refused connection gives the fixed 'not running or not paired' text", async () => {
		const f = fakeFetch(() => {
			throw new TypeError("fetch failed");
		});
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.code, "app_unreachable");
		assert.equal(err.message, "the LearnHarness app is not running or not paired; start it and try again.");
		assert.equal(err.message, NOT_RUNNING_MESSAGE);
	});

	it("an unset token file gives the same text and never calls the app", async () => {
		const f = fakeFetch(() => json(200, {}));
		const err = await failure(api({ tokenFile: undefined }, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.message, NOT_RUNNING_MESSAGE);
		assert.equal(f.reqs.length, 0);
	});

	it("an unreadable token file gives the same text and never calls the app", async () => {
		const f = fakeFetch(() => json(200, {}));
		const err = await failure(
			api({ readFile: () => {
				throw new Error("ENOENT /Users/someone/private/token");
			} }, f.fetch).post("/api/ext/agent/goals", { title: "T" }),
		);
		assert.equal(err.message, NOT_RUNNING_MESSAGE);
		assert.ok(!err.message.includes("/Users/"));
		assert.equal(f.reqs.length, 0);
	});

	it("a call that exceeds the timeout says the app did not answer in time", async () => {
		const f = fakeFetch((req) => {
			if (req.url.endsWith("/api/access/signin")) return signinOk("c");
			throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
		});
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.code, "app_unreachable");
		assert.ok(err.message.includes("did not answer"), err.message);
	});

	it("a sign-in that issues no session cookie is refused with a fixed text", async () => {
		const f = fakeFetch(() => new Response("{}", { status: 200 }));
		const err = await failure(api({}, f.fetch).post("/api/ext/agent/goals", { title: "T" }));
		assert.equal(err.code, "app_rejected");
	});
});

describe("timeouts: create_goal may run long, and is never resent (REQ-graph-agent-08)", () => {
	type Seen = { method: string; url: string };
	/** A fetch that answers after `delayMs`, or rejects with a TimeoutError when its signal aborts first. */
	function slowFetch(delayMs: number, answer: (url: string) => Response) {
		const seen: Seen[] = [];
		const impl = (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			seen.push({ method: init?.method ?? "GET", url });
			if (url.endsWith("/api/access/signin")) return Promise.resolve(signinOk("c"));
			return new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(() => resolve(answer(url)), delayMs);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
				});
			});
		};
		return { fetch: impl as unknown as typeof fetch, seen };
	}

	it("the create_goal POST uses its own, longer timeout: a 60 ms answer succeeds when the ordinary timeout is 20 ms", async () => {
		const f = slowFetch(60, () => json(200, { goalId: "goal_slow", nodeIds: [] }));
		const port = createAppApi({ tokenFile: "/t", allowedHosts: `127.0.0.1:${PORT}`, readFile: () => TOKEN, fetch: f.fetch, timeoutMs: 20, createGoalTimeoutMs: 5_000 });
		assert.deepEqual(await port.post("/api/ext/agent/goals", { title: "slow" }), { goalId: "goal_slow", nodeIds: [] });
	});

	it("any other call keeps the ordinary timeout: a 60 ms GET with a 20 ms timeout is refused as not answered", async () => {
		const f = slowFetch(60, () => json(200, {}));
		const port = createAppApi({ tokenFile: "/t", allowedHosts: `127.0.0.1:${PORT}`, readFile: () => TOKEN, fetch: f.fetch, timeoutMs: 20, createGoalTimeoutMs: 5_000 });
		const err = await failure(port.get("/api/ext/agent/sandbox"));
		assert.ok(err.message.includes("did not answer"), err.message);
		assert.ok(!err.message.includes("list_goals"));
	});

	it("a create_goal that times out says the app may still be working and names list_goals, and is sent exactly once", async () => {
		const f = slowFetch(10_000, () => json(200, {}));
		const port = createAppApi({ tokenFile: "/t", allowedHosts: `127.0.0.1:${PORT}`, readFile: () => TOKEN, fetch: f.fetch, timeoutMs: 30_000, createGoalTimeoutMs: 20 });
		const err = await failure(port.post("/api/ext/agent/goals", { title: "stalls" }));
		assert.equal(err.code, "app_unreachable");
		assert.ok(err.message.includes("may still be working"), err.message);
		assert.ok(err.message.includes("list_goals"), err.message);
		assert.equal(f.seen.filter((s) => s.method === "POST" && s.url.endsWith("/api/ext/agent/goals")).length, 1, "a POST is never resent on timeout");
	});

	it("the default create_goal timeout is ten minutes", async () => {
		const mod = await import("../src/server/ext/mcp/app-api.ts");
		assert.equal(mod.CREATE_GOAL_TIMEOUT_MS, 10 * 60 * 1000);
	});
});

describe("embedQuery (the app embeds a search query; the server holds no model)", () => {
	const EMBED_PATH = "/api/ext/agent/embed-query";

	it("posts the text as a query to the app and returns the vector, model id and dimension", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(200, { vector: [0.5, 0.5], modelId: "m/x", dim: 2 })));
		const out = await api({}, f.fetch).embedQuery("warmth");
		assert.deepEqual(out, { vector: [0.5, 0.5], modelId: "m/x", dim: 2 });
		const call = f.reqs.find((r) => r.url.endsWith(EMBED_PATH))!;
		assert.equal(call.method, "POST");
		assert.deepEqual(call.body, { text: "warmth", kind: "query" });
	});

	it("a 503 with the app's unavailable reason is that reason as the tool error text", async () => {
		const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(503, { unavailable: "unavailable: model not downloaded" })));
		const err = await failure(api({}, f.fetch).embedQuery("warmth"));
		assert.equal(err.code, "app_rejected");
		assert.equal(err.message, "unavailable: model not downloaded");
	});

	it("an answer without a usable vector is refused as an app rejection", async () => {
		const bad = [
			{ vector: [0.5], modelId: "m/x", dim: 2 },
			{ vector: [0.5, "x"], modelId: "m/x", dim: 2 },
			{ vector: [0.5, 0.5], dim: 2 },
		];
		for (const body of bad) {
			const f = fakeFetch((req) => (req.url.endsWith("/api/access/signin") ? signinOk("c") : json(200, body)));
			const err = await failure(api({}, f.fetch).embedQuery("warmth"));
			assert.equal(err.code, "app_rejected");
		}
	});
});
