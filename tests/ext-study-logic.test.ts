// tests/ext-study-logic.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { afterSettled, draftsOf, pageFromInput, postJson, REQUEST_FAILED } from "../components/ext/study-logic.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("postJson never rejects and never leaks raw messages (REQ-study-04 failure paths)", () => {
	it("a network failure is { ok: false } with the fixed text", async () => {
		const r = await postJson(() => Promise.reject(new TypeError("Failed to fetch: 10.0.0.1 internal")), "/x", {});
		assert.deepEqual(r, { ok: false, json: { error: REQUEST_FAILED } });
		assert.equal(REQUEST_FAILED, "The request failed. Try again.");
	});
	it("a non-JSON error body is ok false with an empty object (no text leaks)", async () => {
		const r = await postJson(() => Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })), "/x", {});
		assert.equal(r.ok, false);
		assert.deepEqual(r.json, {});
	});
	it("a body that is null, an array, a string or a number is treated as empty", async () => {
		for (const body of [null, [1, 2], "text", 42]) {
			const r = await postJson(() => Promise.resolve(json(body)), "/x", {});
			assert.deepEqual(r.json, {}, `body ${JSON.stringify(body)}`);
		}
	});
	it("a success is ok true with the object", async () => {
		const r = await postJson(() => Promise.resolve(json({ nodeId: "n_1" })), "/x", {});
		assert.deepEqual(r, { ok: true, json: { nodeId: "n_1" } });
	});
	it("an unserialisable body is a failure, and the request is never sent", async () => {
		let sent = false;
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const r = await postJson(() => ((sent = true), Promise.resolve(json({}))), "/x", cyclic);
		assert.equal(sent, false);
		assert.deepEqual(r, { ok: false, json: { error: REQUEST_FAILED } });
	});
	it("a rapid burst: one failing request does not affect the others", async () => {
		const fetcher = async (url: string) => {
			if (url === "/bad") throw new TypeError("boom");
			return json({ url });
		};
		const results = await Promise.all(["/a", "/bad", "/b", "/bad", "/c"].map((u) => postJson(fetcher, u, {})));
		assert.deepEqual(results.map((r) => r.ok), [true, false, true, false, true]);
		assert.deepEqual(results[2]!.json, { url: "/b" });
	});
	it("the busy pattern resets whatever happens", async () => {
		let busy = false;
		const run = async (fetcher: Parameters<typeof postJson>[0]) => {
			busy = true;
			try {
				return await postJson(fetcher, "/x", {});
			} finally {
				busy = false;
			}
		};
		await run(() => Promise.reject(new Error("x")));
		assert.equal(busy, false);
		await run(() => Promise.resolve(new Response("nope", { status: 500 })));
		assert.equal(busy, false);
	});
});

describe("pageFromInput (typed page number, clamped; null for text that is not a page)", () => {
	it("clamps to the document and accepts padded digits", () => {
		assert.equal(pageFromInput("3", 10), 3);
		assert.equal(pageFromInput(" 007 ", 10), 7);
		assert.equal(pageFromInput("999", 10), 10);
		assert.equal(pageFromInput("0", 10), 1);
		assert.equal(pageFromInput("1", 1), 1);
	});
	it("hostile input is null: empty, letters, signs, decimals, exponents, too long", () => {
		for (const t of ["", "   ", "abc", "1e3", "-5", "3.7", "0x1f", "12a", "1234567", "99999999999999999999", "+4", "٣"]) {
			assert.equal(pageFromInput(t, 10), null, JSON.stringify(t));
		}
	});
	it("a degenerate page count still yields a page of at least 1", () => {
		assert.equal(pageFromInput("5", 0), 1);
	});
});

describe("draftsOf (a drafts response, never trusted as a list)", () => {
	it("anything but a list is no drafts", () => {
		for (const v of [undefined, null, "drafts", 3, {}, { drafts: "x" }, { drafts: { 0: {} } }]) {
			assert.deepEqual(draftsOf({ drafts: v } as Record<string, unknown>), []);
		}
		assert.deepEqual(draftsOf({} as Record<string, unknown>), []);
	});
	it("items without an id or a numeric page are dropped", () => {
		const good = { id: "d1", page: 2, proposition: "p", question: "q", answer: "a" };
		const out = draftsOf({ drafts: [good, null, 7, "x", { id: 5, page: 1 }, { id: "d2", page: "2" }] } as Record<string, unknown>);
		assert.deepEqual(out, [good]);
	});
});

describe("afterSettled (one page draw at a time, the viewer's canvas guard)", () => {
	it("a job waits for a previous job that rejects, and still runs", async () => {
		const order: string[] = [];
		const first = afterSettled(Promise.resolve(), async () => {
			order.push("first");
			throw new Error("render cancelled");
		});
		const second = afterSettled(first.catch(() => undefined), async () => {
			order.push("second");
		});
		await second;
		assert.deepEqual(order, ["first", "second"]);
	});
	it("a rapid burst never overlaps: at most one job is running at any time", async () => {
		let running = 0;
		let peak = 0;
		let chain: Promise<unknown> = Promise.resolve();
		const job = async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, Math.random() * 3));
			running -= 1;
		};
		const done: Promise<void>[] = [];
		for (let i = 0; i < 12; i += 1) {
			chain = afterSettled(chain, job);
			done.push(chain as Promise<void>);
		}
		await Promise.all(done);
		assert.equal(peak, 1);
		assert.equal(running, 0);
	});
	it("a previous job that never rejects also hands over, and the chained promise never rejects by itself", async () => {
		const p = afterSettled(Promise.reject(new Error("earlier")), async () => {});
		await assert.doesNotReject(p);
	});
});
