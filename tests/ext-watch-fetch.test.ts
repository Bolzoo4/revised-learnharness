// tests/ext-watch-fetch.test.ts
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { createFeedFetcher } from "../src/server/ext/watch-fetch.ts";
import { MAX_FEED_BYTES, feedUrl, type WatchEntry } from "../src/core/ext/watch.ts";

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>i1</id><title>Hello</title><link href="https://x.org/1"/><summary>S</summary></entry></feed>`;
const feed = (query: string): WatchEntry => ({ id: "w", kind: "feed", query, cadenceHours: 24 });
const XML = { "content-type": "application/atom+xml; charset=utf-8" };

interface Call { url: string; init: RequestInit | undefined }
function fake(handler: (url: string, n: number, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const f = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, calls.length, init);
	}) as unknown as typeof fetch;
	return { f, calls };
}
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const ok = (body: string, headers: Record<string, string> = XML) => new Response(body, { status: 200, headers });

describe("createFeedFetcher: targets", () => {
	const refused = [
		"http://localhost/f", "http://169.254.169.254/latest", "http://10.0.0.5/f", "http://[::1]/f", "https://user:pw@x.org/f", "ftp://x.org/f",
		"https://100.100.100.200/", "http://[::ffff:100.64.0.1]/f", "https://192.0.0.1/f", "https://198.18.0.1/f", "https://224.0.0.1/f",
		"https://255.255.255.255/f", "http://[ff02::1]/f", "http://[fec0::1]/f", "http://[2002:7f00:1::1]/f", "http://0.0.0.0/f",
		"http://[::ffff:127.0.0.1]/f", "http://127.1/f", "http://[fe80::1]/f", "http://[fd00::1]/f", "http://x.localhost/f", "http://x.internal/f",
	];
	for (const q of refused) {
		it(`rejects ${q} before any network call`, async () => {
			const { f, calls } = fake(() => ok(ATOM));
			await assert.rejects(createFeedFetcher({ fetch: f })(feed(q)), /feed|watch/i);
			assert.equal(calls.length, 0);
		});
	}

	it("fetches the entry's URL with redirect:manual, a signal and no credentials or cookies", async () => {
		const { f, calls } = fake(() => ok(ATOM));
		const items = await createFeedFetcher({ fetch: f })(feed("https://x.org/feed.xml"));
		assert.deepEqual(items.map((i) => i.id), ["i1"]);
		const init = calls[0]!.init!;
		assert.equal(init.redirect, "manual");
		assert.ok(init.signal instanceof AbortSignal);
		const headers = new Headers(init.headers);
		assert.deepEqual([...headers.keys()], ["accept"]);
		assert.ok(init.credentials === undefined || init.credentials === "omit");
	});

	it("uses the arXiv and repo URLs of watch.ts", async () => {
		const { f, calls } = fake(() => ok(ATOM));
		const arxiv: WatchEntry = { id: "a", kind: "arxiv-query", query: "cat:cs.LG", cadenceHours: 24 };
		const repo: WatchEntry = { id: "r", kind: "repo", query: "o/n", cadenceHours: 24 };
		await createFeedFetcher({ fetch: f })(arxiv);
		await createFeedFetcher({ fetch: f })(repo);
		assert.deepEqual(calls.map((c) => c.url), [feedUrl(arxiv), feedUrl(repo)]);
	});
});

describe("createFeedFetcher: redirects", () => {
	for (const target of ["http://169.254.169.254/latest/meta-data", "http://localhost/admin", "https://127.0.0.1/x", "https://u:p@y.org/f"]) {
		it(`refuses a 302 to ${target} without following it`, async () => {
			const { f, calls } = fake((url) => (url.startsWith("https://x.org") ? redirect(target) : ok(ATOM)));
			await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /redirect/i);
			assert.equal(calls.length, 1);
		});
	}

	it("follows a relative redirect and a public absolute one, max 3 hops", async () => {
		const { f, calls } = fake((url, n) => (n === 1 ? redirect("/moved") : n === 2 ? redirect("https://y.org/f", 301) : ok(ATOM)));
		assert.equal((await createFeedFetcher({ fetch: f })(feed("https://x.org/f"))).length, 1);
		assert.deepEqual(calls.map((c) => c.url), ["https://x.org/f", "https://x.org/moved", "https://y.org/f"]);
	});

	it("gives up after 3 redirects", async () => {
		const { f, calls } = fake((_u, n) => redirect(`https://x.org/h${n}`));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /too many redirects/i);
		assert.equal(calls.length, 4);
	});

	it("refuses an https to http downgrade but allows http to https", async () => {
		const down = fake(() => redirect("http://y.org/f"));
		await assert.rejects(createFeedFetcher({ fetch: down.f })(feed("https://x.org/f")), /redirect/i);
		const up = fake((_u, n) => (n === 1 ? redirect("https://y.org/f") : ok(ATOM)));
		assert.equal((await createFeedFetcher({ fetch: up.f })(feed("http://x.org/f"))).length, 1);
	});

	it("a redirect without a usable Location fails clearly", async () => {
		const { f } = fake(() => new Response(null, { status: 302 }));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /redirect/i);
	});
});

describe("createFeedFetcher: body, type, time, errors", () => {
	it("aborts an oversized streaming body as soon as the cap is crossed", async () => {
		let pulled = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled++;
				c.enqueue(new Uint8Array(100));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { f } = fake(() => new Response(stream, { status: 200, headers: XML }));
		await assert.rejects(createFeedFetcher({ fetch: f, maxBytes: 1000 })(feed("https://x.org/f")), /too large/i);
		assert.ok(pulled <= 15, `pulled ${pulled} chunks`);
		assert.ok(cancelled);
	});

	it("rejects a declared content-length over the cap without reading", async () => {
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
		const { f } = fake(() => new Response(body, { status: 200, headers: { ...XML, "content-length": String(MAX_FEED_BYTES + 1) } }));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /too large/i);
		assert.equal(cancelled, true);
		assert.equal(pulls, 0);
	});

	it("the default cap is MAX_FEED_BYTES", async () => {
		const { f } = fake(() => ok("x".repeat(MAX_FEED_BYTES + 1)));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /too large/i);
	});

	it("times out a hanging fetch", async () => {
		const timer = setTimeout(() => {}, 500);
		try {
			const hang = fake((_u, _n, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("secret internal abort detail")))));
			await assert.rejects(createFeedFetcher({ fetch: hang.f, timeoutMs: 30 })(feed("https://x.org/f")), (e: Error) => /timed out/i.test(e.message) && !/secret/.test(e.message));
		} finally {
			clearTimeout(timer);
		}
	});

	it("times out a hanging body", async () => {
		const timer = setTimeout(() => {}, 500);
		try {
			let settle: () => void = () => {};
			const body = new ReadableStream<Uint8Array>({
				pull: () => new Promise((resolve) => { settle = () => resolve(); }),
				cancel: () => { settle(); },
			});
			const slow = fake(() => new Response(body, { status: 200, headers: XML }));
			await assert.rejects(createFeedFetcher({ fetch: slow.f, timeoutMs: 30 })(feed("https://x.org/f")), /timed out/i);
		} finally {
			clearTimeout(timer);
		}
	});

	it("accepts xml, atom, rss and text bodies and rejects other content types", async () => {
		for (const type of ["application/xml", "text/xml", "application/rss+xml", "application/atom+xml;charset=utf-8", "text/plain"]) {
			const { f } = fake(() => ok(ATOM, { "content-type": type }));
			assert.equal((await createFeedFetcher({ fetch: f })(feed("https://x.org/f"))).length, 1, type);
		}
		for (const headers of [{ "content-type": "text/html" } as Record<string, string>, { "content-type": "application/json" }, { "content-type": "application/pdf" }, {} as Record<string, string>]) {
			const { f } = fake(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(ATOM)); c.close(); } }), { status: 200, headers }));
			await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /content type/i);
		}
	});

	it("reports an HTTP error by status only and hides network error details", async () => {
		const bad = fake(() => new Response("<html>stack trace at /srv/app.js</html>", { status: 503, headers: { "content-type": "text/html" } }));
		await assert.rejects(createFeedFetcher({ fetch: bad.f })(feed("https://x.org/secret?token=abc")), (e: Error) => e.message === "feed: HTTP 503");
		const boom = fake(() => { throw new Error("connect ECONNREFUSED 10.1.2.3:80 at Socket.connect (node:net:1)"); });
		await assert.rejects(createFeedFetcher({ fetch: boom.f })(feed("https://x.org/f")), (e: Error) => e.message === "feed: request failed");
	});

	it("decodes multi-byte characters split across chunks and tolerates an empty body", async () => {
		const bytes = new TextEncoder().encode(ATOM.replace("Hello", "Héllo"));
		const cut = bytes.indexOf(0xc3) + 1;
		const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
		const a = fake(() => new Response(stream, { status: 200, headers: XML }));
		assert.equal((await createFeedFetcher({ fetch: a.f })(feed("https://x.org/f")))[0]!.title, "Héllo");
		const b = fake(() => new Response(null, { status: 200, headers: XML }));
		assert.deepEqual(await createFeedFetcher({ fetch: b.f })(feed("https://x.org/f")), []);
	});
});

describe("createFeedFetcher: hardening of the body reader", () => {
	it("keeps at most one abort listener on the request signal however many chunks the body has", async () => {
		let signal: AbortSignal | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				for (let i = 0; i < 5000; i++) c.enqueue(new Uint8Array([0x20]));
				c.close();
			},
		});
		const { f } = fake((_u, _n, init) => {
			signal = init!.signal!;
			return new Response(stream, { status: 200, headers: XML });
		});
		await createFeedFetcher({ fetch: f })(feed("https://x.org/f"));
		assert.ok(getEventListeners(signal!, "abort").length <= 1, `listeners left: ${getEventListeners(signal!, "abort").length}`);
	});

	it("decodes the body with the charset named in content-type", async () => {
		const latin1Bytes = Buffer.from(ATOM.replace("Hello", "café"), "latin1"); // é is the single byte 0xE9
		const { f } = fake(() => new Response(latin1Bytes, { status: 200, headers: { "content-type": "application/atom+xml; charset=iso-8859-1" } }));
		assert.equal((await createFeedFetcher({ fetch: f })(feed("https://x.org/f")))[0]!.title, "café");
	});

	it("falls back to utf-8 for an unknown charset and ignores a malformed content-length", async () => {
		const { f } = fake(() => new Response(ATOM.replace("Hello", "Héllo"), { status: 200, headers: { "content-type": "application/atom+xml; charset=no-such-charset", "content-length": "abc" } }));
		assert.equal((await createFeedFetcher({ fetch: f })(feed("https://x.org/f")))[0]!.title, "Héllo");
	});

	it("exports FeedError, whose instances carry the feed: prefix", async () => {
		const mod = (await import("../src/server/ext/watch-fetch.ts")) as unknown as { FeedError?: new (m: string) => Error };
		assert.equal(typeof mod.FeedError, "function");
		const { f } = fake(() => new Response(null, { status: 503 }));
		const err = await createFeedFetcher({ fetch: f })(feed("https://x.org/f")).catch((e: unknown) => e);
		assert.ok(mod.FeedError !== undefined && err instanceof mod.FeedError);
		assert.equal((err as Error).message, "feed: HTTP 503");
	});
});

describe("createFeedFetcher: redirect targets and body cancellation", () => {
	for (const target of ["file:///etc/passwd", "data:text/xml,<feed/>", "//169.254.169.254/latest", "http://[::1]/f", "https://[fe80::1]/f"]) {
		it(`refuses a redirect to ${target}`, async () => {
			const { f, calls } = fake((url) => (url.startsWith("https://x.org") ? redirect(target) : ok(ATOM)));
			await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /redirect/i);
			assert.equal(calls.length, 1);
		});
	}

	it("refuses a private target reached at hop 2, after a public hop 1", async () => {
		const { f, calls } = fake((_u, n) => (n === 1 ? redirect("https://y.org/a") : redirect("http://10.0.0.9/x")));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /redirect/i);
		assert.deepEqual(calls.map((c) => c.url), ["https://x.org/f", "https://y.org/a"]);
	});

	for (const status of [307, 308]) {
		it(`follows a ${status} redirect to a public target`, async () => {
			const { f, calls } = fake((_u, n) => (n === 1 ? redirect("https://y.org/f", status) : ok(ATOM)));
			assert.equal((await createFeedFetcher({ fetch: f })(feed("https://x.org/f"))).length, 1);
			assert.deepEqual(calls.map((c) => c.url), ["https://x.org/f", "https://y.org/f"]);
		});
	}

	const cancelBody = () => {
		const state = { cancelled: false };
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				c.enqueue(new TextEncoder().encode(ATOM));
				c.close();
			},
			cancel() {
				state.cancelled = true;
			},
		});
		return { body, state };
	};

	it("cancels the body of a followed redirect", async () => {
		const { body, state } = cancelBody();
		const { f } = fake((_u, n) => (n === 1 ? new Response(body, { status: 302, headers: { location: "https://y.org/f" } }) : ok(ATOM)));
		await createFeedFetcher({ fetch: f })(feed("https://x.org/f"));
		assert.equal(state.cancelled, true);
	});

	it("cancels the body of a non-OK response", async () => {
		const { body, state } = cancelBody();
		const { f } = fake(() => new Response(body, { status: 500, headers: { "content-type": "text/html" } }));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /HTTP 500/);
		assert.equal(state.cancelled, true);
	});

	it("cancels the body of a response with the wrong content type", async () => {
		const { body, state } = cancelBody();
		const { f } = fake(() => new Response(body, { status: 200, headers: { "content-type": "text/html" } }));
		await assert.rejects(createFeedFetcher({ fetch: f })(feed("https://x.org/f")), /content type/i);
		assert.equal(state.cancelled, true);
	});
});
