/**
 * The extension prompt settings: the file store, the service rules, and the two
 * routes (GET /api/ext/prompts, PUT and DELETE /api/ext/prompts/[id]).
 * TEST-DIR ISOLATION: LH_DATA_DIR is set before any app-module import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ext-prompt-settings-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { PROMPTS_OVERRIDE_DIR } = await import("../config.ts");
const list = await import("../app/api/ext/prompts/route.ts");
const item = await import("../app/api/ext/prompts/[id]/route.ts");
const { resolveExtPrompt } = await import("../src/agent/ext/prompt-override.ts");
const { EXT_PROMPT_IDS, EXT_PROMPT_MAX_TEXT_CHARS } = await import("../src/core/ext/prompt-catalog.ts");

const SWITCHES = path.join(TMP_DATA, "ext", "prompt-switches.json");
const EXT_OVERRIDES = path.join(PROMPTS_OVERRIDE_DIR, "ext");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(path.join(TMP_DATA, "ext"), { recursive: true, force: true });
	fs.rmSync(PROMPTS_OVERRIDE_DIR, { recursive: true, force: true });
});

type View = { id: string; label: string; description: string; warning: string; defaultText: string; overrideText: string | null; enabled: boolean };

function put(id: string, body: unknown, raw?: string): Request {
	return new Request(`http://localhost/api/ext/prompts/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: raw ?? JSON.stringify(body),
	});
}
function ctx(id: string): { params: Promise<{ id: string }> } {
	return { params: Promise.resolve({ id }) };
}
async function putPrompt(id: string, body: unknown, raw?: string): Promise<{ status: number; json: any }> {
	const res = await item.PUT(put(id, body, raw), ctx(id));
	return { status: res.status, json: await res.json() };
}
async function deletePrompt(id: string): Promise<{ status: number; json: any }> {
	const res = await item.DELETE(new Request(`http://localhost/api/ext/prompts/${id}`, { method: "DELETE" }), ctx(id));
	return { status: res.status, json: await res.json() };
}
async function listPrompts(): Promise<View[]> {
	return (await (await list.GET()).json()) as View[];
}
async function viewOf(id: string): Promise<View> {
	const found = (await listPrompts()).find((v) => v.id === id);
	assert.ok(found, id);
	return found;
}

describe("GET /api/ext/prompts", () => {
	it("lists every editable prompt in catalog order, with its default and no version yet", async () => {
		const views = await listPrompts();
		assert.deepEqual(views.map((v) => v.id), [...EXT_PROMPT_IDS]);
		for (const v of views) {
			assert.ok(v.label && v.description && v.warning, `${v.id}: catalog fields`);
			assert.ok(v.defaultText.trim() !== "", `${v.id}: default text`);
			assert.equal(v.overrideText, null);
			assert.equal(v.enabled, false);
		}
	});
});

describe("PUT /api/ext/prompts/[id]", () => {
	it("saves a version without turning it on", async () => {
		const res = await putPrompt("verifier", { text: "MINE" });
		assert.equal(res.status, 200);
		assert.equal(res.json.overrideText, "MINE");
		assert.equal(res.json.enabled, false);
		assert.equal(resolveExtPrompt("verifier", "DEFAULT"), "DEFAULT", "a saved file alone is not in use");
	});

	it("saves and turns on in one request; the agent layer then reads the version", async () => {
		const res = await putPrompt("review-daily", { text: "MINE daily", enabled: true });
		assert.equal(res.status, 200);
		assert.equal(res.json.enabled, true);
		assert.equal(resolveExtPrompt("review-daily", "DEFAULT"), "MINE daily");
	});

	it("turns a switch off and keeps the file", async () => {
		await putPrompt("review-daily", { text: "MINE", enabled: true });
		const res = await putPrompt("review-daily", { enabled: false });
		assert.equal(res.status, 200);
		assert.equal(res.json.enabled, false);
		assert.equal(res.json.overrideText, "MINE");
		assert.equal(resolveExtPrompt("review-daily", "DEFAULT"), "DEFAULT");
	});

	it("refuses to turn a switch on when there is no version to use", async () => {
		const res = await putPrompt("verifier", { enabled: true });
		assert.equal(res.status, 400);
		assert.equal(res.json.error, "write a version of the prompt before turning it on");
		assert.equal((await viewOf("verifier")).enabled, false);
	});

	it("accepts an empty version (upstream allows it; it contributes no text)", async () => {
		const res = await putPrompt("study-assistant", { text: "", enabled: true });
		assert.equal(res.status, 200);
		assert.equal(resolveExtPrompt("study-assistant", "DEFAULT"), "");
	});

	it("answers 404 for an id outside the catalog, with a fixed message", async () => {
		const evil = "..%2F..%2Fetc%2Fpasswd";
		const res = await putPrompt(evil, { text: "x" });
		assert.equal(res.status, 404);
		assert.equal(res.json.error, "unknown extension prompt");
		assert.ok(!JSON.stringify(res.json).includes("passwd"), "no input echo");
		assert.equal(fs.existsSync(TMP_DATA + "/etc"), false);
	});

	it("answers 400 for a body of the wrong shape, with a fixed message", async () => {
		const shape = "the body must be {text?: string, enabled?: boolean}";
		for (const body of [{}, { text: 5 }, { enabled: "yes" }, { text: "x", extra: 1 }, { text: null }]) {
			const res = await putPrompt("verifier", body);
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal(res.json.error, shape);
		}
		const notAnObject = await putPrompt("verifier", null, "[1,2]");
		assert.equal(notAnObject.status, 400);
		const malformed = await putPrompt("verifier", null, "{oops");
		assert.equal(malformed.status, 400);
		assert.equal(fs.existsSync(EXT_OVERRIDES), false, "nothing written for a refused body");
	});

	it("bounds the text at 20000 characters", async () => {
		const over = await putPrompt("verifier", { text: "a".repeat(EXT_PROMPT_MAX_TEXT_CHARS + 1) });
		assert.equal(over.status, 400);
		assert.equal(over.json.error, "the text is longer than 20000 characters");
		assert.equal(fs.existsSync(path.join(EXT_OVERRIDES, "verifier.md")), false);
		const at = await putPrompt("verifier", { text: "a".repeat(EXT_PROMPT_MAX_TEXT_CHARS) });
		assert.equal(at.status, 200);
	});

	it("answers 413 for a body beyond the request cap", async () => {
		const res = await putPrompt("verifier", null, "{\"text\":\"" + "a".repeat(300 * 1024) + "\"}");
		assert.equal(res.status, 413);
	});

	it("writes only under the ext override folder, with no temp files left behind", async () => {
		await putPrompt("explanation-style", { text: "STYLE", enabled: true });
		assert.deepEqual(fs.readdirSync(EXT_OVERRIDES).sort(), ["explanation-style.md"]);
		assert.equal(fs.readFileSync(path.join(EXT_OVERRIDES, "explanation-style.md"), "utf-8"), "STYLE");
		assert.deepEqual(fs.readdirSync(path.join(TMP_DATA, "ext")).filter((f) => f.includes(".tmp-")), []);
		assert.deepEqual(JSON.parse(fs.readFileSync(SWITCHES, "utf-8")), { "explanation-style": true });
	});
});

describe("DELETE /api/ext/prompts/[id] (reset to default)", () => {
	it("removes the file and clears the switch, so the record and the route agree", async () => {
		await putPrompt("debrief-style", { text: "MINE", enabled: true });
		const res = await deletePrompt("debrief-style");
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { id: "debrief-style", deleted: true, switchCleared: true });
		assert.equal(fs.existsSync(path.join(EXT_OVERRIDES, "debrief-style.md")), false);
		assert.equal((await viewOf("debrief-style")).overrideText, null);
		assert.equal((await viewOf("debrief-style")).enabled, false);
		assert.equal(JSON.parse(fs.readFileSync(SWITCHES, "utf-8"))["debrief-style"], undefined);
	});

	it("is idempotent, and reports no switch cleared when none was on", async () => {
		await putPrompt("verifier", { text: "MINE" });
		assert.deepEqual((await deletePrompt("verifier")).json, { id: "verifier", deleted: true, switchCleared: false });
		assert.deepEqual((await deletePrompt("verifier")).json, { id: "verifier", deleted: true, switchCleared: false });
	});

	it("keeps the other switches", async () => {
		await putPrompt("verifier", { text: "A", enabled: true });
		await putPrompt("watch-classifier", { text: "B", enabled: true });
		await deletePrompt("verifier");
		assert.deepEqual(JSON.parse(fs.readFileSync(SWITCHES, "utf-8")), { "watch-classifier": true });
	});

	it("answers 404 for an unknown id and touches nothing", async () => {
		await putPrompt("verifier", { text: "A", enabled: true });
		const res = await deletePrompt("nope");
		assert.equal(res.status, 404);
		assert.equal(res.json.error, "unknown extension prompt");
		assert.equal((await viewOf("verifier")).enabled, true);
	});
});
