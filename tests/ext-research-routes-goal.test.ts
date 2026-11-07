// tests/ext-research-routes-goal.test.ts
// The cycle route's goal input (REQ-rs-19). Its own file: the other route tests mock researchService.start and do not restore it.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-research-goal-route-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const cycle = await import("../app/api/ext/research/cycle/route.ts");
const { researchService } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const post = (url: string, body: unknown) =>
	new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("research cycle route: goal (REQ-rs-19)", () => {
	it("POST action=start passes the goal to researchService.start as sent", async () => {
		let seen: unknown = "not called";
		const stub = mock.method(researchService, "start", (_trigger: unknown, goal: unknown) => {
			seen = goal;
			return { started: true };
		});
		const res = await cycle.POST(post("/api/ext/research/cycle", { action: "start", goal: "  Quantum error correction  " }));
		stub.mock.restore();
		assert.equal(res.status, 200);
		assert.equal(seen, "  Quantum error correction  ");
	});

	it("a goal that is not text, or is over 500 characters, is 400 and nothing starts", async () => {
		const before = researchService.status().running;
		for (const goal of [42, null, ["x"], "x".repeat(501)]) {
			const res = await cycle.POST(post("/api/ext/research/cycle", { action: "start", goal }));
			assert.equal(res.status, 400, JSON.stringify(goal).slice(0, 20));
			assert.equal(typeof (await res.json()).error, "string");
		}
		assert.equal(researchService.status().running, before);
	});

	it("GET status carries reports (an array) and no goal while idle", async () => {
		const data = await (await cycle.GET()).json();
		assert.deepEqual(data.reports, []);
		assert.equal("goal" in data, false);
	});
});
