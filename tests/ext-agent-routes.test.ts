// tests/ext-agent-routes.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

// The seam, BEFORE any config-loading import (access settings are cached on first read).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agent-routes-"));
const TOKEN = "q".repeat(64);
const origin = "http://127.0.0.1:47890";
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
fs.writeFileSync(path.join(TMP_DATA, "token"), TOKEN, { mode: 0o600 });
process.env.LH_ACCESS_TOKEN_FILE = path.join(TMP_DATA, "token");
process.env.LH_ACCESS_ALLOWED_HOSTS = "127.0.0.1:47890";

const { proxy } = await import("../proxy.ts");
const { issueSession } = await import("../src/server/access/session.ts");
const goals = await import("../app/api/ext/agent/goals/route.ts");
const weights = await import("../app/api/ext/agent/goals/[id]/weights/route.ts");
const links = await import("../app/api/ext/agent/links/route.ts");
const sandbox = await import("../app/api/ext/agent/sandbox/route.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const cookie = `lh_session=${issueSession(TOKEN, Date.now()).value}`;
const json = (body: unknown) => new Request(`${origin}/api/x`, { method: "POST", headers: { "content-type": "application/json", origin, host: "127.0.0.1:47890" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The gate as the app runs it, for a request that carries (or lacks) the session cookie. */
function gateFor(path: string, method: string, withCookie: boolean) {
	return proxy(
		new NextRequest(origin + path, {
			method,
			headers: { host: "127.0.0.1:47890", origin, ...(withCookie ? { cookie } : {}) },
		}),
	);
}

describe("agent endpoints are behind the access gate", () => {
	it("refuse every call without a session with 401 JSON", () => {
		for (const [p, m] of [["/api/ext/agent/goals", "POST"], ["/api/ext/agent/goals/goal_x/weights", "PUT"], ["/api/ext/agent/links", "POST"], ["/api/ext/agent/sandbox", "GET"]] as const) {
			const res = gateFor(p, m, false);
			assert.equal(res.status, 401, `${m} ${p}`);
		}
	});

	it("pass the gate with a valid session cookie", () => {
		assert.equal(gateFor("/api/ext/agent/goals", "POST", true).headers.get("x-middleware-next"), "1");
	});
});

describe("agent endpoints", () => {
	it("POST goals answers 200 with the goal id and node ids", async () => {
		const res = await goals.POST(json({ title: "Route goal", targets: ["The route test statement holds."] }));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { goalId: string; nodeIds: string[] };
		assert.match(body.goalId, /^goal_/);
		assert.equal(body.nodeIds.length, 1);
	});

	it("POST goals names the malformed field in a 400", async () => {
		const res = await goals.POST(json({ title: 5, targets: ["x"] }));
		assert.equal(res.status, 400);
		assert.match((await res.json() as { error: string }).error, /title/);
	});

	it("PUT weights on an unknown goal is a 404", async () => {
		const res = await weights.PUT(json({ chain: 2 }), params("goal_ghost"));
		assert.equal(res.status, 404);
	});

	it("GET sandbox answers 200 with the folder's path and its page of files, and creates the folder", async () => {
		const res = await sandbox.GET();
		assert.equal(res.status, 200);
		const body = (await res.json()) as { path: string; files: { items: unknown[]; count: number; truncated: boolean } };
		assert.equal(path.basename(body.path), "agent-sandbox");
		assert.deepEqual(body.files, { items: [], count: 0, truncated: false });
	});

	it("POST links with an unknown node is a 400 listing the problems", async () => {
		const res = await links.POST(json({ from: "node_a", to: "node_b", linkType: "sequence" }));
		assert.equal(res.status, 400);
		const body = (await res.json()) as { problems: string[] };
		assert.ok(body.problems.length >= 1);
	});
});
