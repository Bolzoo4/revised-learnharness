import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-research-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const marks = await import("../app/api/ext/research/marks/route.ts");
const inbox = await import("../app/api/ext/research/inbox/route.ts");
const watchlist = await import("../app/api/ext/research/watchlist/route.ts");
const cycle = await import("../app/api/ext/research/cycle/route.ts");
const log = await import("../app/api/ext/research/log/route.ts");
const radar = await import("../app/api/ext/research/radar/route.ts");
const { researchAdmin, researchService, InboxError } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const get = (url: string) => new Request(`http://localhost${url}`);
const post = (url: string, body: unknown) =>
	new Request(`http://localhost${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
const del = (url: string, body?: unknown) =>
	new Request(`http://localhost${url}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
	});

const quiet = () => mock.method(console, "error", () => {});

/** A thrown non-HttpError must be a 500 with a generic body: no message, no stack. */
async function assertInternal(res: Response, secret = "boom: /secret/path") {
	assert.equal(res.status, 500);
	const text = await res.text();
	assert.deepEqual(JSON.parse(text), { error: "internal error" });
	assert.ok(!text.includes(secret) && !text.includes(" at "));
}

describe("research marks routes", () => {
	it("GET /api/ext/research/marks lists marks (empty at start)", async () => {
		const res = await marks.GET(get("/api/ext/research/marks"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { marks: [] });
	});

	it("GET /api/ext/research/marks works without arguments", async () => {
		const res = await marks.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { marks: [] });
	});

	it("GET /api/ext/research/marks: 400 on invalid limit", async () => {
		for (const limit of ["-1", "0", "100", "invalid"]) {
			const res = await marks.GET(get(`/api/ext/research/marks?limit=${limit}`));
			assert.equal(res.status, 400);
			assert.equal(typeof (await res.json()).error, "string");
		}
	});

	it("GET /api/ext/research/marks: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "listMarks", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await marks.GET(get("/api/ext/research/marks")));
	});

	it("POST /api/ext/research/marks creates a mark (author user, 201)", async () => {
		const res = await marks.POST(
			post("/api/ext/research/marks", {
				scope: { kind: "node", id: "target-node" },
				mark: "expand",
				maxDepth: 2,
				budgetUsd: 1.5,
				note: "explore depth 2",
			}),
		);
		assert.equal(res.status, 201);
		const data = await res.json();
		assert.equal(typeof data.mark.id, "string");
		assert.deepEqual(data.mark.scope, { kind: "node", id: "target-node" });
		assert.equal(data.mark.mark, "expand");
		assert.equal(data.mark.maxDepth, 2);
		assert.equal(data.mark.budgetUsd, 1.5);
		assert.equal(data.mark.note, "explore depth 2");
		assert.equal(data.mark.author, "user");

		// GET reflects the new mark
		const listRes = await marks.GET(get("/api/ext/research/marks"));
		const listData = await listRes.json();
		assert.equal(listData.marks.length, 1);
		assert.equal(listData.marks[0].id, data.mark.id);
	});

	it("POST /api/ext/research/marks: 400 on malformed body or invalid schema", async () => {
		for (const body of ["{not json", "[]", "null", {}, { scope: { kind: "invalid", id: "n" }, mark: "expand" }, { scope: { kind: "node", id: "n" }, mark: "bogus" }]) {
			const res = await marks.POST(post("/api/ext/research/marks", body));
			assert.equal(res.status, 400);
			assert.equal(typeof (await res.json()).error, "string");
		}
	});

	it("POST /api/ext/research/marks: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "setMark", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(
			await marks.POST(
				post("/api/ext/research/marks", {
					scope: { kind: "node", id: "n" },
					mark: "expand",
				}),
			),
		);
	});

	it("DELETE /api/ext/research/marks: deletes by query param and by body", async () => {
		// Create two marks
		const m1 = researchAdmin.setMark({ scope: { kind: "node", id: "n1" }, mark: "expand" });
		const m2 = researchAdmin.setMark({ scope: { kind: "node", id: "n2" }, mark: "hold" });

		// Delete m1 via ?id=
		const res1 = await marks.DELETE(del(`/api/ext/research/marks?id=${m1.id}`));
		assert.equal(res1.status, 200);
		assert.deepEqual(await res1.json(), { ok: true });

		// Delete m2 via JSON body
		const res2 = await marks.DELETE(del("/api/ext/research/marks", { id: m2.id }));
		assert.equal(res2.status, 200);
		assert.deepEqual(await res2.json(), { ok: true });

		// Neither is in the list
		const remaining = researchAdmin.listMarks();
		assert.ok(!remaining.some((m) => m.id === m1.id || m.id === m2.id));
	});

	it("DELETE /api/ext/research/marks: 404 for unknown mark", async () => {
		const res = await marks.DELETE(del("/api/ext/research/marks?id=missing-mark-id"));
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "no such mark" });
	});

	it("DELETE /api/ext/research/marks: 400 when id is missing or invalid", async () => {
		const resEmpty = await marks.DELETE(del("/api/ext/research/marks"));
		assert.equal(resEmpty.status, 400);
		assert.deepEqual(await resEmpty.json(), { error: "an id is required" });

		const resTooLong = await marks.DELETE(del(`/api/ext/research/marks?id=${"x".repeat(201)}`));
		assert.equal(resTooLong.status, 400);
	});

	it("DELETE /api/ext/research/marks: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "clearMark", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await marks.DELETE(del("/api/ext/research/marks?id=some-mark")));
	});
});

describe("research inbox routes", () => {
	it("GET /api/ext/research/inbox lists items (empty at start)", async () => {
		const res = await inbox.GET(get("/api/ext/research/inbox"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { items: [] });
	});

	it("GET /api/ext/research/inbox works without arguments", async () => {
		const res = await inbox.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { items: [] });
	});

	it("GET /api/ext/research/inbox: 400 on invalid status or limit", async () => {
		const resStatus = await inbox.GET(get("/api/ext/research/inbox?status=invalid"));
		assert.equal(resStatus.status, 400);

		const resLimit = await inbox.GET(get("/api/ext/research/inbox?limit=-1"));
		assert.equal(resLimit.status, 400);
	});

	it("GET /api/ext/research/inbox: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "listInbox", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await inbox.GET(get("/api/ext/research/inbox")));
	});

	it("POST /api/ext/research/inbox: 400 on malformed body or invalid inputs", async () => {
		for (const body of [
			"{bad",
			"[]",
			null,
			{},
			{ locator: "", decision: "approved" },
			{ locator: "arxiv:2301.00001", decision: "invalid" },
			{ locator: "arxiv:2301.00001", decision: "approved", tier: "invalid" },
		]) {
			const res = await inbox.POST(post("/api/ext/research/inbox", body));
			assert.equal(res.status, 400);
			assert.equal(typeof (await res.json()).error, "string");
		}
	});

	it("POST /api/ext/research/inbox: 404 for un-queued or missing locator", async () => {
		const res = await inbox.POST(
			post("/api/ext/research/inbox", {
				locator: "https://example.com/not-in-inbox",
				decision: "approved",
			}),
		);
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "no pending inbox source at that locator" });
	});

	it("POST /api/ext/research/inbox: maps InboxError code not-found to 404, others to 400", async () => {
		mock.method(researchAdmin, "decideInbox", async () => {
			throw new InboxError("not-found", "item not found");
		});
		const res404 = await inbox.POST(post("/api/ext/research/inbox", { locator: "loc", decision: "approved" }));
		assert.equal(res404.status, 404);
		assert.deepEqual(await res404.json(), { error: "item not found" });

		mock.method(researchAdmin, "decideInbox", async () => {
			throw new InboxError("in-progress", "already in progress");
		});
		const res400 = await inbox.POST(post("/api/ext/research/inbox", { locator: "loc", decision: "approved" }));
		assert.equal(res400.status, 400);
		assert.deepEqual(await res400.json(), { error: "already in progress" });
	});

	it("POST /api/ext/research/inbox: successful decision returns 200 with result", async () => {
		mock.method(researchAdmin, "decideInbox", async () => ({ decision: "approved" as const, nodesAdded: 3 }));
		const res = await inbox.POST(
			post("/api/ext/research/inbox", {
				locator: "https://arxiv.org/abs/2301.00001",
				decision: "approved",
				tier: "primary",
			}),
		);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { decision: "approved", nodesAdded: 3 });
	});

	it("POST /api/ext/research/inbox: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "decideInbox", async () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(
			await inbox.POST(
				post("/api/ext/research/inbox", {
					locator: "loc",
					decision: "approved",
				}),
			),
		);
	});
});

describe("research watchlist routes", () => {
	it("GET /api/ext/research/watchlist lists entries (empty at start)", async () => {
		const res = await watchlist.GET(get("/api/ext/research/watchlist"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { entries: [] });
	});

	it("GET /api/ext/research/watchlist works without arguments", async () => {
		const res = await watchlist.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { entries: [] });
	});

	it("GET /api/ext/research/watchlist: 400 on invalid limit", async () => {
		const res = await watchlist.GET(get("/api/ext/research/watchlist?limit=0"));
		assert.equal(res.status, 400);
	});

	it("GET /api/ext/research/watchlist: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "listWatchlist", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await watchlist.GET(get("/api/ext/research/watchlist")));
	});

	it("POST /api/ext/research/watchlist adds a watch entry (201)", async () => {
		const res = await watchlist.POST(
			post("/api/ext/research/watchlist", {
				kind: "arxiv-query",
				query: "cat:cs.AI",
				cadenceHours: 24,
			}),
		);
		assert.equal(res.status, 201);
		const data = await res.json();
		assert.equal(typeof data.entry.id, "string");
		assert.equal(data.entry.kind, "arxiv-query");
		assert.equal(data.entry.query, "cat:cs.AI");
		assert.equal(data.entry.cadenceHours, 24);

		// Verified in GET
		const listRes = await watchlist.GET(get("/api/ext/research/watchlist"));
		const listData = await listRes.json();
		assert.equal(listData.entries.length, 1);
		assert.equal(listData.entries[0].id, data.entry.id);
	});

	it("POST /api/ext/research/watchlist: 400 on invalid input", async () => {
		for (const body of [
			"{not json",
			"[]",
			null,
			{},
			{ kind: "unknown", query: "foo" },
			{ kind: "arxiv-query", query: "" },
			{ kind: "arxiv-query", query: "cat:cs.AI", cadenceHours: 0 },
			{ kind: "arxiv-query", query: "cat:cs.AI", cadenceHours: 9999 },
		]) {
			const res = await watchlist.POST(post("/api/ext/research/watchlist", body));
			assert.equal(res.status, 400);
			assert.equal(typeof (await res.json()).error, "string");
		}
	});

	it("POST /api/ext/research/watchlist: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "addWatch", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(
			await watchlist.POST(
				post("/api/ext/research/watchlist", {
					kind: "arxiv-query",
					query: "cat:cs.AI",
				}),
			),
		);
	});

	it("DELETE /api/ext/research/watchlist removes entry by ?id= and by body", async () => {
		const w1 = researchAdmin.addWatch({ kind: "arxiv-query", query: "cat:cs.LG" });
		const w2 = researchAdmin.addWatch({ kind: "arxiv-query", query: "cat:cs.RO" });

		// DELETE w1 via query param
		const res1 = await watchlist.DELETE(del(`/api/ext/research/watchlist?id=${w1.id}`));
		assert.equal(res1.status, 200);
		assert.deepEqual(await res1.json(), { ok: true });

		// DELETE w2 via body
		const res2 = await watchlist.DELETE(del("/api/ext/research/watchlist", { id: w2.id }));
		assert.equal(res2.status, 200);
		assert.deepEqual(await res2.json(), { ok: true });
	});

	it("DELETE /api/ext/research/watchlist: 404 for unknown entry", async () => {
		const res = await watchlist.DELETE(del("/api/ext/research/watchlist?id=missing-watch-id"));
		assert.equal(res.status, 404);
		assert.deepEqual(await res.json(), { error: "no such watch entry" });
	});

	it("DELETE /api/ext/research/watchlist: 400 when id is missing", async () => {
		const res = await watchlist.DELETE(del("/api/ext/research/watchlist"));
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: "an id is required" });
	});

	it("DELETE /api/ext/research/watchlist: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "removeWatch", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await watchlist.DELETE(del("/api/ext/research/watchlist?id=some-id")));
	});
});

describe("research cycle routes", () => {
	it("GET /api/ext/research/cycle returns cycle status", async () => {
		const res = await cycle.GET();
		assert.equal(res.status, 200);
		const status = await res.json();
		assert.equal(status.running, false);
		assert.deepEqual(status.steers, []);
		assert.equal(status.lastCycle, null);
	});

	it("GET /api/ext/research/cycle: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchService, "status", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await cycle.GET());
	});

	it("POST /api/ext/research/cycle: 400 on malformed body or invalid action", async () => {
		for (const body of ["{bad", "[]", null, {}, { action: "unknown" }, { action: "" }]) {
			const res = await cycle.POST(post("/api/ext/research/cycle", body));
			assert.equal(res.status, 400);
			assert.equal(typeof (await res.json()).error, "string");
		}
	});

	it("POST /api/ext/research/cycle: action=start calls researchService.start", async () => {
		mock.method(researchService, "start", (trigger: unknown) => {
			assert.equal(trigger, "manual");
			return { started: true };
		});
		const res = await cycle.POST(post("/api/ext/research/cycle", { action: "start" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { started: true });

		// With explicit trigger=schedule
		mock.method(researchService, "start", (trigger: unknown) => {
			assert.equal(trigger, "schedule");
			return { started: false, reason: "not-configured" };
		});
		const resSched = await cycle.POST(post("/api/ext/research/cycle", { action: "start", trigger: "schedule" }));
		assert.equal(resSched.status, 200);
		assert.deepEqual(await resSched.json(), { started: false, reason: "not-configured" });
	});

	it("POST /api/ext/research/cycle: action=start hides unexpected errors behind 500", async () => {
		quiet();
		mock.method(researchService, "start", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await cycle.POST(post("/api/ext/research/cycle", { action: "start" })));
	});

	it("POST /api/ext/research/cycle: action=steer validates message and delegates to researchService.steer", async () => {
		// Empty message is 400
		const resEmpty = await cycle.POST(post("/api/ext/research/cycle", { action: "steer", message: "" }));
		assert.equal(resEmpty.status, 400);

		// Valid message
		mock.method(researchService, "steer", (msg: unknown) => {
			assert.equal(msg, "steer towards theorem 1");
			return "delivered";
		});
		const res = await cycle.POST(post("/api/ext/research/cycle", { action: "steer", message: "steer towards theorem 1" }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { status: "delivered" });
	});

	it("POST /api/ext/research/cycle: action=steer hides unexpected errors behind 500", async () => {
		quiet();
		mock.method(researchService, "steer", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await cycle.POST(post("/api/ext/research/cycle", { action: "steer", message: "valid message" })));
	});

	it("POST /api/ext/research/cycle: action=abort delegates to researchService.abort", async () => {
		mock.method(researchService, "abort", () => true);
		const resTrue = await cycle.POST(post("/api/ext/research/cycle", { action: "abort" }));
		assert.equal(resTrue.status, 200);
		assert.deepEqual(await resTrue.json(), { aborted: true });

		mock.method(researchService, "abort", () => false);
		const resFalse = await cycle.POST(post("/api/ext/research/cycle", { action: "abort" }));
		assert.equal(resFalse.status, 200);
		assert.deepEqual(await resFalse.json(), { aborted: false });
	});

	it("POST /api/ext/research/cycle: action=abort hides unexpected errors behind 500", async () => {
		quiet();
		mock.method(researchService, "abort", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await cycle.POST(post("/api/ext/research/cycle", { action: "abort" })));
	});
});

describe("research log routes", () => {
	it("GET /api/ext/research/log lists cycle log (empty at start)", async () => {
		const res = await log.GET(get("/api/ext/research/log"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { log: [] });
	});

	it("GET /api/ext/research/log works without arguments", async () => {
		const res = await log.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { log: [] });
	});

	it("GET /api/ext/research/log: 400 on invalid limit", async () => {
		const res = await log.GET(get("/api/ext/research/log?limit=-1"));
		assert.equal(res.status, 400);
	});

	it("GET /api/ext/research/log: respects limit and returns log items", async () => {
		mock.method(researchAdmin, "readLog", (limit?: number) => {
			assert.equal(limit, 5);
			return [{ cycleId: "c1", trigger: "manual" as const, startedAt: "2026-11-05T00:00:00.000Z", durationSeconds: 10, phaseOutcomes: [] }];
		});
		const res = await log.GET(get("/api/ext/research/log?limit=5"));
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.log.length, 1);
		assert.equal(data.log[0].cycleId, "c1");
	});

	it("GET /api/ext/research/log: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "readLog", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await log.GET(get("/api/ext/research/log")));
	});
});

describe("research radar routes", () => {
	it("GET /api/ext/research/radar lists classified radar events (empty at start)", async () => {
		const res = await radar.GET(get("/api/ext/research/radar"));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { radar: [] });
	});

	it("GET /api/ext/research/radar works without arguments", async () => {
		const res = await radar.GET();
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { radar: [] });
	});

	it("GET /api/ext/research/radar: 400 on invalid limit", async () => {
		const res = await radar.GET(get("/api/ext/research/radar?limit=0"));
		assert.equal(res.status, 400);
	});

	it("GET /api/ext/research/radar: respects limit and returns items", async () => {
		mock.method(researchAdmin, "listRadar", (limit?: number) => {
			assert.equal(limit, 10);
			return [{ type: "classified" as const, target: { kind: "arxiv-query" as const, query: "q" }, item: { locator: "loc", title: "t" }, decision: "relevant" as const, at: "2026-11-05T00:00:00.000Z" }];
		});
		const res = await radar.GET(get("/api/ext/research/radar?limit=10"));
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.radar.length, 1);
		assert.equal(data.radar[0].decision, "relevant");
	});

	it("GET /api/ext/research/radar: hides unexpected errors behind a 500", async () => {
		quiet();
		mock.method(researchAdmin, "listRadar", () => {
			throw new Error("boom: /secret/path");
		});
		await assertInternal(await radar.GET(get("/api/ext/research/radar")));
	});
});

describe("research session route", () => {
	it("POST creates a research chat and returns its id", async () => {
		const session = await import("../app/api/ext/research/session/route.ts");
		const { getChat } = await import("../src/server/index.ts");
		const res = await session.POST();
		assert.equal(res.status, 200);
		const { chatId } = (await res.json()) as { chatId: string };
		assert.equal(typeof chatId, "string");
		assert.equal(getChat(chatId)?.kind, "research");
	});
});

describe("research cycle route contract", () => {
	it("POST action=start refuses a trigger that is not manual or schedule (400, nothing started)", async () => {
		let called = false;
		mock.method(researchService, "start", () => {
			called = true;
			return { started: true };
		});
		const res = await cycle.POST(post("/api/ext/research/cycle", { action: "start", trigger: "anything-else" }));
		assert.equal(res.status, 400);
		assert.equal(called, false);
	});

	it("POST action=steer with no running cycle is 409 with a fixed message", async () => {
		mock.method(researchService, "steer", () => null);
		const res = await cycle.POST(post("/api/ext/research/cycle", { action: "steer", message: "try theorem 2" }));
		assert.equal(res.status, 409);
		const body = (await res.json()) as { error?: unknown };
		assert.equal(typeof body.error, "string");
	});
});
