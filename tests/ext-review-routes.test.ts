// tests/ext-review-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const answer = await import("../app/api/ext/review/answer/route.ts");
const session = await import("../app/api/ext/review/session/route.ts");
const { personalLayer, parseReviewAnswer, parseSessionRequest, HttpError, ReviewInputError } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const quiet = () => mock.method(console, "error", () => {});

describe("parseReviewAnswer", () => {
	it("accepts a node, a rating 1 to 4, and an optional duration (default 1 second)", () => {
		assert.deepEqual(parseReviewAnswer({ nodeId: "n_a", rating: 3 }), { nodeId: "n_a", rating: 3, durationSec: 1 });
		assert.deepEqual(parseReviewAnswer({ nodeId: "n_a", rating: 1, durationSec: 12.6 }), { nodeId: "n_a", rating: 1, durationSec: 13 });
	});
	it("clamps the duration to 1..900 seconds, as the agent's measured duration is clamped", () => {
		assert.equal(parseReviewAnswer({ nodeId: "n", rating: 2, durationSec: 0 }).durationSec, 1);
		assert.equal(parseReviewAnswer({ nodeId: "n", rating: 2, durationSec: 5000 }).durationSec, 900);
	});
	it("rejects each bad field with its fixed message", () => {
		const cases: Array<[unknown, string]> = [
			[{ rating: 3 }, "nodeId must be a non-empty string"],
			[{ nodeId: "", rating: 3 }, "nodeId must be a non-empty string"],
			[{ nodeId: 7, rating: 3 }, "nodeId must be a non-empty string"],
			[{ nodeId: "n" }, "rating must be 1, 2, 3 or 4"],
			[{ nodeId: "n", rating: 0 }, "rating must be 1, 2, 3 or 4"],
			[{ nodeId: "n", rating: 5 }, "rating must be 1, 2, 3 or 4"],
			[{ nodeId: "n", rating: 2.5 }, "rating must be 1, 2, 3 or 4"],
			[{ nodeId: "n", rating: "3" }, "rating must be 1, 2, 3 or 4"],
			[{ nodeId: "n", rating: 3, durationSec: "10" }, "durationSec must be a number of seconds, 0 or more"],
			[{ nodeId: "n", rating: 3, durationSec: -1 }, "durationSec must be a number of seconds, 0 or more"],
			[{ nodeId: "n", rating: 3, durationSec: Number.NaN }, "durationSec must be a number of seconds, 0 or more"],
		];
		for (const [body, message] of cases) {
			assert.throws(() => parseReviewAnswer(body as Record<string, unknown>), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === message, JSON.stringify(body));
		}
	});
});

describe("parseSessionRequest", () => {
	it("no body, or a body without cardId, is a plain daily-review session", () => {
		assert.deepEqual(parseSessionRequest(null), {});
		assert.deepEqual(parseSessionRequest(["x"]), {});
		assert.deepEqual(parseSessionRequest({}), {});
	});
	it("a cardId must be a non-empty string", () => {
		assert.deepEqual(parseSessionRequest({ cardId: "card_1" }), { cardId: "card_1" });
		for (const cardId of ["", 3, null]) {
			assert.throws(() => parseSessionRequest({ cardId }), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === "cardId must be a card id");
		}
	});
	it("a nodeId is accepted alone; it must be a non-empty string", () => {
		assert.deepEqual(parseSessionRequest({ nodeId: "n_a" }), { nodeId: "n_a" });
		for (const nodeId of ["", 3, null]) {
			assert.throws(() => parseSessionRequest({ nodeId }), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === "nodeId must be a node id");
		}
	});
	it("a cardId and a nodeId together are refused with one fixed message", () => {
		assert.throws(
			() => parseSessionRequest({ cardId: "card_1", nodeId: "n_a" }),
			(e: unknown) => e instanceof HttpError && e.status === 400 && e.message === "send a cardId or a nodeId, not both",
		);
	});
});

describe("POST /api/ext/review/answer", () => {
	it("400 for a malformed body, with the fixed message", async () => {
		for (const body of ["{not json", "[]", "null"]) {
			const res = await answer.POST(post("/api/ext/review/answer", body));
			assert.equal(res.status, 400, body);
			assert.equal((await res.json() as { error: string }).error, "the request body must be a JSON object");
		}
		const res = await answer.POST(post("/api/ext/review/answer", { nodeId: "n", rating: 9 }));
		assert.equal(res.status, 400);
		assert.equal((await res.json() as { error: string }).error, "rating must be 1, 2, 3 or 4");
	});

	it("400 for a node that is not a card item of today's plan (nothing is recorded)", async () => {
		const res = await answer.POST(post("/api/ext/review/answer", { nodeId: "n_missing", rating: 3, durationSec: 10 }));
		assert.equal(res.status, 400);
		assert.equal((await res.json() as { error: string }).error, "this node is not a card item of today's plan");
	});

	it("a valid rating is handed to the personal layer with the clamped duration, and answers ok with the next due date", async () => {
		const seen: unknown[] = [];
		mock.method(personalLayer, "answerCard", (input: unknown) => {
			seen.push(input);
			return { dueAt: "2026-11-10T00:00:00.000Z", credited: [], penalised: [] };
		});
		const res = await answer.POST(post("/api/ext/review/answer", { nodeId: "n_a", rating: 4, durationSec: 99999 }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, dueAt: "2026-11-10T00:00:00.000Z" });
		assert.deepEqual(seen, [{ nodeId: "n_a", rating: 4, durationSec: 900 }]);
	});

	it("an unknown node from the core is a 404 with a fixed message", async () => {
		mock.method(personalLayer, "answerCard", () => {
			throw new ReviewInputError("unknown", "unknown node: n_secret");
		});
		const res = await answer.POST(post("/api/ext/review/answer", { nodeId: "n_secret", rating: 2 }));
		assert.equal(res.status, 404);
		assert.equal((await res.json() as { error: string }).error, "unknown node");
	});

	it("an unexpected failure is a generic 500 with no message or stack", async () => {
		quiet();
		mock.method(personalLayer, "answerCard", () => {
			throw new Error("boom: /secret/path");
		});
		const res = await answer.POST(post("/api/ext/review/answer", { nodeId: "n_a", rating: 2 }));
		const text = await res.text();
		assert.equal(res.status, 500);
		assert.deepEqual(JSON.parse(text), { error: "internal error" });
		assert.ok(!text.includes("secret"));
	});
});

describe("POST /api/ext/review/session with a cardId", () => {
	it("a plain session (no body) is still a 200 with a chatId", async () => {
		const res = await session.POST(post("/api/ext/review/session", {}));
		assert.equal(res.status, 200);
		assert.equal(typeof (await res.json()).chatId, "string");
	});
	it("a malformed cardId is a 400", async () => {
		const res = await session.POST(post("/api/ext/review/session", { cardId: "" }));
		assert.equal(res.status, 400);
		assert.equal((await res.json() as { error: string }).error, "cardId must be a card id");
	});
	it("the cardId is passed to the personal layer, which starts a focused session", async () => {
		const seen: unknown[] = [];
		mock.method(personalLayer, "startReviewSession", (cardId?: string) => {
			seen.push(cardId);
			return { chatId: "chat_focus" };
		});
		const res = await session.POST(post("/api/ext/review/session", { cardId: "card_1" }));
		assert.deepEqual(await res.json(), { chatId: "chat_focus" });
		assert.deepEqual(seen, ["card_1"]);
	});
	it("a nodeId starts a node-focused session, and nothing else is passed", async () => {
		const seen: unknown[] = [];
		mock.method(personalLayer, "startNodeSession", (nodeId: string) => {
			seen.push(nodeId);
			return { chatId: "chat_node" };
		});
		const daily: unknown[] = [];
		mock.method(personalLayer, "startReviewSession", (cardId?: string) => {
			daily.push(cardId);
			return { chatId: "chat_daily" };
		});
		const res = await session.POST(post("/api/ext/review/session", { nodeId: "n_a" }));
		assert.deepEqual(await res.json(), { chatId: "chat_node" });
		assert.deepEqual(seen, ["n_a"]);
		assert.deepEqual(daily, [], "the daily-review path is not taken");
	});
	it("a cardId and a nodeId together are a 400 and start nothing", async () => {
		const seen: unknown[] = [];
		mock.method(personalLayer, "startNodeSession", () => (seen.push("node"), { chatId: "x" }));
		mock.method(personalLayer, "startReviewSession", () => (seen.push("card"), { chatId: "x" }));
		const res = await session.POST(post("/api/ext/review/session", { cardId: "card_1", nodeId: "n_a" }));
		assert.equal(res.status, 400);
		assert.equal((await res.json() as { error: string }).error, "send a cardId or a nodeId, not both");
		assert.deepEqual(seen, []);
	});
	it("an unknown node is a 404 with the core's fixed message", async () => {
		const res = await session.POST(post("/api/ext/review/session", { nodeId: "n_missing" }));
		assert.equal(res.status, 404);
		assert.equal((await res.json() as { error: string }).error, "unknown node");
	});
	it("an unknown card is a 404 with the core's fixed message", async () => {
		const res = await session.POST(post("/api/ext/review/session", { cardId: "card_missing" }));
		assert.equal(res.status, 404);
		assert.equal((await res.json() as { error: string }).error, "unknown card");
	});
	it("a thrown HttpError keeps its status", async () => {
		mock.method(personalLayer, "startReviewSession", () => {
			throw new HttpError(409, "busy");
		});
		assert.equal((await session.POST(post("/api/ext/review/session", { cardId: "card_1" }))).status, 409);
	});
});
