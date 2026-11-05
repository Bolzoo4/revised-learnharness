import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-node-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const panel = await import("../app/api/ext/nodes/[id]/panel/route.ts");
const actions = await import("../app/api/ext/nodes/[id]/actions/route.ts");
const { HttpError, NodeKnowledgeError } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("node knowledge errors", () => {
	it("are HttpErrors carrying their status", () => {
		const e = new NodeKnowledgeError(409, "conflict");
		assert.ok(e instanceof HttpError);
		assert.equal(e.status, 409);
	});
	it("an unknown node is a 404 JSON error from the panel route", async () => {
		const res = await panel.GET(new Request("http://localhost/api/ext/nodes/ghost/panel"), params("ghost"));
		assert.equal(res.status, 404);
		assert.match((await res.json() as { error: string }).error, /unknown node/);
		const bad = await actions.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "nope" }) }), params("ghost"));
		assert.equal(bad.status, 400);
	});
});
