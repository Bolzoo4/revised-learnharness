// tests/ext-mcp-write.test.ts
/**
 * The agent write tools (REQ-graph-agent-16): create_goal, set_goal_weights and
 * create_link reach the app only through the injected AppApiPort. These tests use
 * a fake port, real temp files and real data directories. The server itself never
 * writes: every store's write method here throws.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import type { AppApiPort, McpDeps } from "../src/core/ext/mcp/ports.ts";
import { runTool, TOOL_NAMES, toolFields, toolGroup } from "../src/core/ext/mcp/tools.ts";
import { CATALOG } from "../src/server/ext/mcp/catalog.ts";
import { cleanupAllFixtures, makeFixture, N, seedStandard, type Fixture } from "./helpers/mcp-fixture.ts";

afterEach(cleanupAllFixtures);

const WRITE_TOOLS = ["create_goal", "set_goal_weights", "create_link"];
const PDF_BYTES = Buffer.from("%PDF-1.4\n% a small test document\n%%EOF\n");
const tmpDirs: string[] = [];
function tempDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-write-"));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface Sent {
	method: "post" | "put";
	path: string;
	body: any;
}

/** A fake app: records every request and answers with `reply`, which may throw a ToolError (the live port's job). */
function fakeApi(reply: (sent: Sent) => unknown = () => ({})): { port: AppApiPort; sent: Sent[] } {
	const sent: Sent[] = [];
	const send = (method: "post" | "put") => async (p: string, body: unknown) => {
		const s = { method, path: p, body } as Sent;
		sent.push(s);
		return reply(s);
	};
	return { port: { post: send("post"), put: send("put") }, sent };
}

/** The fixture's deps with the fake port and stores that refuse every write (spied). */
function depsWith(f: Fixture, port: AppApiPort, writes: string[]): McpDeps {
	const refuse = (name: string) => ({
		appendEvent(): void {
			writes.push(name);
			throw new Error("write attempted by the server");
		},
	});
	const d = f.deps;
	return {
		...d,
		appApi: port,
		review: {
			...d.review,
			goalsStore: { ...d.review.goalsStore, ...refuse("goals") },
			reviewStore: { ...d.review.reviewStore, ...refuse("review") },
			cardsStore: { ...d.review.cardsStore, ...refuse("cards") },
		},
	};
}

async function attempt(fn: () => unknown): Promise<{ ok: true; value: any } | { ok: false; code: string; message: string }> {
	try {
		return { ok: true, value: await fn() };
	} catch (e) {
		if (e instanceof ToolError) return { ok: false, code: e.code, message: e.message };
		throw e;
	}
}

function treeDigest(root: string): string {
	const hash = createHash("sha256");
	const walk = (dir: string) => {
		for (const name of fs.readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			hash.update(path.relative(root, full));
			if (fs.statSync(full).isDirectory()) walk(full);
			else hash.update(fs.readFileSync(full));
		}
	};
	walk(root);
	return hash.digest("hex");
}

function pdf(name: string, bytes: Buffer = PDF_BYTES): string {
	const p = path.join(tempDir(), name);
	fs.writeFileSync(p, bytes);
	return p;
}

describe("registration of the write tools (REQ-graph-agent-16)", () => {
	it("the three write tools are in the write group, and their zod schemas match the core field lists", () => {
		for (const name of WRITE_TOOLS) {
			assert.equal(toolGroup(name), "write", name);
			assert.deepEqual(Object.keys(CATALOG[name]!.input.shape).sort(), [...toolFields(name)].sort(), name);
		}
		assert.ok(TOOL_NAMES.includes("create_goal") && TOOL_NAMES.includes("set_goal_weights") && TOOL_NAMES.includes("create_link"));
	});

	it("under --knowledge-only the write tools are disabled and never reach the port", async () => {
		const f = makeFixture();
		const api = fakeApi();
		for (const name of WRITE_TOOLS) {
			const o = await attempt(() => runTool(name, depsWith(f, api.port, []), { title: "x", goalId: "goal_x", from: "a", to: "b", linkType: "analogy", weights: {} }, { knowledgeOnly: true }));
			assert.equal(o.ok, false, name);
			assert.equal((o as { code: string }).code, "disabled", name);
		}
		assert.equal(api.sent.length, 0);
	});
});

describe("create_goal (REQ-graph-agent-16)", () => {
	it("forwards title, targets, weights and priority, sends the PDF as base64, and returns the app's goalId", async () => {
		const f = makeFixture();
		seedStandard(f);
		const file = pdf("book.pdf");
		const api = fakeApi(() => ({ goalId: "goal_new000000001", nodeIds: ["n_new1"] }));
		const out = await runTool(
			"create_goal",
			depsWith(f, api.port, []),
			{ title: "Measure theory", targets: ["Every sigma algebra is closed under countable unions."], files: [{ name: "book.pdf", path: file }], weights: { chain: 2 }, priority: 4 },
			{ knowledgeOnly: false },
		);
		assert.deepEqual(out, { goalId: "goal_new000000001", nodeIds: ["n_new1"] });
		assert.equal(api.sent.length, 1);
		assert.equal(api.sent[0]!.method, "post");
		assert.equal(api.sent[0]!.path, "/api/ext/agent/goals");
		assert.deepEqual(api.sent[0]!.body, {
			title: "Measure theory",
			targets: ["Every sigma algebra is closed under countable unions."],
			files: [{ name: "book.pdf", dataBase64: PDF_BYTES.toString("base64") }],
			weights: { chain: 2 },
			priority: 4,
		});
	});

	it("sends only the fields the agent gave", async () => {
		const f = makeFixture();
		const api = fakeApi(() => ({ goalId: "goal_x", nodeIds: [] }));
		await runTool("create_goal", depsWith(f, api.port, []), { title: "Only a title" }, { knowledgeOnly: false });
		assert.deepEqual(api.sent[0]!.body, { title: "Only a title" });
	});

	it("surfaces the app's 429 text verbatim as a tool error, not as a crash", async () => {
		const f = makeFixture();
		const text = "the daily spending ceiling for agent work is reached; try again tomorrow";
		const api = fakeApi(() => {
			throw new ToolError("app_rejected", text);
		});
		const o = await attempt(() => runTool("create_goal", depsWith(f, api.port, []), { title: "Blocked" }, { knowledgeOnly: false }));
		assert.equal(o.ok, false);
		assert.equal((o as { message: string }).message, text);
	});

	it("a missing file is a clear error before any call is made, and the message names no path", async () => {
		const f = makeFixture();
		const api = fakeApi();
		const missing = path.join(tempDir(), "absent.pdf");
		const o = await attempt(() => runTool("create_goal", depsWith(f, api.port, []), { title: "T", files: [{ name: "absent.pdf", path: missing }] }, { knowledgeOnly: false }));
		assert.equal(o.ok, false);
		assert.equal((o as { code: string }).code, "invalid_input");
		assert.ok(!(o as { message: string }).message.includes(missing));
		assert.equal(api.sent.length, 0);
	});

	it("refuses a relative path, a non-PDF file, a name that is not .pdf, a file over 20 MB and more than 5 files, all before any call", async () => {
		const f = makeFixture();
		const api = fakeApi();
		const notPdf = pdf("notes.pdf", Buffer.from("hello, not a pdf"));
		const wrongName = pdf("notes.txt");
		const huge = pdf("huge.pdf");
		fs.truncateSync(huge, 20 * 1024 * 1024 + 1);
		const cases: Array<[string, unknown]> = [
			["relative", { title: "T", files: [{ name: "a.pdf", path: "relative/a.pdf" }] }],
			["not a pdf", { title: "T", files: [{ name: "notes.pdf", path: notPdf }] }],
			["name not pdf", { title: "T", files: [{ name: "notes.txt", path: wrongName }] }],
			["over 20 MB", { title: "T", files: [{ name: "huge.pdf", path: huge }] }],
			["six files", { title: "T", files: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, path: pdf(`f${i}.pdf`) })) }],
		];
		for (const [label, input] of cases) {
			const o = await attempt(() => runTool("create_goal", depsWith(f, api.port, []), input, { knowledgeOnly: false }));
			assert.equal(o.ok, false, label);
			assert.equal((o as { code: string }).code, "invalid_input", label);
		}
		assert.equal(api.sent.length, 0);
	});

	it("refuses an unknown argument such as a delete flag", async () => {
		const f = makeFixture();
		const api = fakeApi();
		const o = await attempt(() => runTool("create_goal", depsWith(f, api.port, []), { title: "T", delete: true }, { knowledgeOnly: false }));
		assert.equal((o as { code: string }).code, "invalid_input");
		assert.equal(api.sent.length, 0);
	});
});

describe("set_goal_weights and create_link (REQ-graph-agent-16)", () => {
	it("set_goal_weights puts the weights to the goal's weights route", async () => {
		const f = makeFixture();
		const api = fakeApi(() => ({ goal: { id: "goal_w" } }));
		await runTool("set_goal_weights", depsWith(f, api.port, []), { goalId: "goal_w 1", weights: { analogy: 0 } }, { knowledgeOnly: false });
		assert.equal(api.sent[0]!.method, "put");
		assert.equal(api.sent[0]!.path, `/api/ext/agent/goals/${encodeURIComponent("goal_w 1")}/weights`);
		assert.deepEqual(api.sent[0]!.body, { analogy: 0 });
	});

	it("create_link posts the typed link", async () => {
		const f = makeFixture();
		const api = fakeApi(() => ({ link: { from: N.a, to: N.b } }));
		await runTool("create_link", depsWith(f, api.port, []), { from: N.a, to: N.b, linkType: "analogy" }, { knowledgeOnly: false });
		assert.equal(api.sent[0]!.method, "post");
		assert.equal(api.sent[0]!.path, "/api/ext/agent/links");
		assert.deepEqual(api.sent[0]!.body, { from: N.a, to: N.b, linkType: "analogy" });
	});

	it("create_link refuses a link type outside the closed list before any call", async () => {
		const f = makeFixture();
		const api = fakeApi();
		const o = await attempt(() => runTool("create_link", depsWith(f, api.port, []), { from: N.a, to: N.b, linkType: "bogus" }, { knowledgeOnly: false }));
		assert.equal((o as { code: string }).code, "invalid_input");
		assert.equal(api.sent.length, 0);
	});
});

describe("the server never writes the data (REQ-graph-agent-16)", () => {
	it("no write tool calls a store's write method, and the data directory is byte-identical afterwards", async () => {
		const f = makeFixture();
		seedStandard(f);
		const before = treeDigest(f.root);
		const writes: string[] = [];
		const api = fakeApi(() => ({ goalId: "goal_x", nodeIds: [], goal: {}, link: {} }));
		const deps = depsWith(f, api.port, writes);
		await runTool("create_goal", deps, { title: "T", files: [{ name: "a.pdf", path: pdf("a.pdf") }] }, { knowledgeOnly: false });
		await runTool("set_goal_weights", deps, { goalId: "goal_x", weights: { chain: 1 } }, { knowledgeOnly: false });
		await runTool("create_link", deps, { from: N.a, to: N.b, linkType: "analogy" }, { knowledgeOnly: false });
		assert.equal(api.sent.length, 3);
		assert.deepEqual(writes, []);
		assert.equal(treeDigest(f.root), before);
	});
});
