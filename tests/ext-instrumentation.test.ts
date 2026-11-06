import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// The seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-instrumentation-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");

const savedRuntime = process.env.NEXT_RUNTIME;
after(() => {
	if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
	else process.env.NEXT_RUNTIME = savedRuntime;
});
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

describe("instrumentation register()", () => {
	it("is inert under NODE_ENV=test: starts no timer and does not throw", async () => {
		const { register } = await import("../instrumentation.ts");
		process.env.NEXT_RUNTIME = "nodejs";
		await register();
		const holder = globalThis as unknown as { __lhResearchScheduler?: { running: boolean; timer?: unknown } };
		assert.equal(holder.__lhResearchScheduler?.running, true);
		assert.equal(holder.__lhResearchScheduler?.timer, undefined);
	});
});
