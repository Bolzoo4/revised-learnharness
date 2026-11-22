// tests/ext-sandbox.test.ts
/**
 * The agent sandbox (REQ-graph-agent-22..25), on real temp directories. resolveInSandbox refuses every
 * name that escapes the folder or is not a PDF; the goal service attaches only sandbox files, validating
 * all of them before the first import; the listing and the MCP tool report the same folder.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import type { GoalEvent } from "../src/core/ext/goals.ts";
import type { GoalsStore } from "../src/core/ext/ports.ts";
import { listSandbox, resolveInSandbox, SANDBOX_MAX_FILE_BYTES } from "../src/core/ext/sandbox.ts";
import { ToolError } from "../src/core/ext/mcp/errors.ts";
import { toolGroup, toolReadOnly, runTool } from "../src/core/ext/mcp/tools.ts";
import type { AppApiPort } from "../src/core/ext/mcp/ports.ts";
import { createAgentGoal, readAgentSandbox, type AgentGoalsDeps } from "../src/server/ext/agent-goals.ts";
import { createSandboxAccess, liveSandboxFs } from "../src/server/ext/sandbox-live.ts";
import { createMemoryGraphStore } from "./helpers/memory-graph-store.ts";
import { cleanupAllFixtures, makeFixture } from "./helpers/mcp-fixture.ts";

const NOW = "2026-11-22T10:00:00.000Z";
const PDF = new TextEncoder().encode("%PDF-1.4\nsample document\n%%EOF\n");

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sandbox-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	cleanupAllFixtures();
});

/** A base temp folder with the sandbox folder inside it, created as the app creates it. */
function sandboxAt(): { base: string; root: string } {
	const base = tmp();
	const root = path.join(base, "agent-sandbox");
	fs.mkdirSync(root, { mode: 0o700 });
	return { base, root };
}

function put(dir: string, rel: string, content: string | Uint8Array): string {
	const file = path.join(dir, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** The refusal reason for a name the sandbox must refuse (the test fails if it is accepted). */
async function refusal(root: string, name: unknown, fsPort = liveSandboxFs): Promise<string> {
	const result = await resolveInSandbox(root, name, fsPort);
	assert.equal(result.ok, false, `${JSON.stringify(name)} must be refused`);
	return (result as { ok: false; reason: string }).reason;
}

describe("resolveInSandbox accepts a plain PDF inside the folder", () => {
	it("a PDF at the top of the folder and one in a sub-folder are accepted, with their real path and size", async () => {
		const { root } = sandboxAt();
		const top = put(root, "book.pdf", PDF);
		put(root, "course/unit/notes.pdf", PDF);
		const result = await resolveInSandbox(root, "book.pdf", liveSandboxFs);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.path, fs.realpathSync(top));
		assert.equal(result.size, PDF.byteLength);
		assert.equal((await resolveInSandbox(root, "course/unit/notes.pdf", liveSandboxFs)).ok, true);
	});
});

describe("resolveInSandbox refuses every name that escapes or is not a PDF", () => {
	it("empty, NUL, absolute, parent-segment, backslash, trailing-separator and empty-segment names", async () => {
		const { base, root } = sandboxAt();
		put(base, "outside.pdf", PDF);
		put(root, "book.pdf", PDF);
		const absolute = path.join(root, "book.pdf");
		const cases: unknown[] = ["", "a\0b.pdf", absolute, "/book.pdf", "../outside.pdf", "sub/../book.pdf", "..", "a\\b.pdf", "book.pdf/", "./book.pdf", "a//book.pdf", 5];
		for (const name of cases) {
			const reason = await refusal(root, name);
			assert.ok(!reason.includes(base), `the reason for ${JSON.stringify(name)} must not echo the folder: ${reason}`);
			assert.ok(!reason.includes(absolute), reason);
		}
	});

	it("a missing file and a directory named like a PDF are refused", async () => {
		const { root } = sandboxAt();
		assert.match(await refusal(root, "missing.pdf"), /not .*sandbox|no such|not found/i);
		fs.mkdirSync(path.join(root, "folder.pdf"));
		assert.match(await refusal(root, "folder.pdf"), /regular file/);
	});

	it("a name that does not end in .pdf is refused even when its bytes are a PDF", async () => {
		const { root } = sandboxAt();
		put(root, "notes.txt", PDF);
		assert.match(await refusal(root, "notes.txt"), /\.pdf/);
	});

	it("a file named .pdf whose first bytes are not %PDF- is refused", async () => {
		const { root } = sandboxAt();
		put(root, "fake.pdf", "hello, this is not a pdf");
		assert.match(await refusal(root, "fake.pdf"), /not a PDF/);
	});

	it("a symbolic link to a file outside the folder is refused", async () => {
		const { base, root } = sandboxAt();
		const secret = put(base, "secret/private.pdf", PDF);
		fs.symlinkSync(secret, path.join(root, "link.pdf"));
		assert.match(await refusal(root, "link.pdf"), /symbolic link/);
	});

	it("a symbolic link to a file inside the folder is refused too: no link is ever followed", async () => {
		const { root } = sandboxAt();
		put(root, "book.pdf", PDF);
		fs.symlinkSync("book.pdf", path.join(root, "alias.pdf"));
		assert.match(await refusal(root, "alias.pdf"), /symbolic link/);
	});

	it("a symbolic link used as a folder component is refused, even when its target is a folder outside", async () => {
		const { base, root } = sandboxAt();
		put(base, "elsewhere/inside.pdf", PDF);
		fs.symlinkSync(path.join(base, "elsewhere"), path.join(root, "linkdir"));
		assert.match(await refusal(root, "linkdir/inside.pdf"), /symbolic link/);
	});

	it("a symbolic link loop is refused without being followed", async () => {
		const { root } = sandboxAt();
		fs.symlinkSync("loop.pdf", path.join(root, "loop.pdf"));
		assert.match(await refusal(root, "loop.pdf"), /symbolic link/);
	});

	it("a file over 20 MB is refused by size (a sparse file of exactly the limit plus one byte)", async () => {
		const { root } = sandboxAt();
		const big = put(root, "big.pdf", PDF);
		fs.truncateSync(big, SANDBOX_MAX_FILE_BYTES + 1);
		assert.match(await refusal(root, "big.pdf"), /20 MB/);
	});

	it("a file of exactly 20 MB is accepted", async () => {
		const { root } = sandboxAt();
		const edge = put(root, "edge.pdf", PDF);
		fs.truncateSync(edge, SANDBOX_MAX_FILE_BYTES);
		assert.equal((await resolveInSandbox(root, "edge.pdf", liveSandboxFs)).ok, true);
	});
});

describe("listSandbox", () => {
	it("lists files with relative names, sizes and ISO modification times, down to depth 3 only, never symbolic links", async () => {
		const { base, root } = sandboxAt();
		put(root, "a.pdf", PDF);
		put(root, "d1/b.txt", "text");
		put(root, "d1/d2/c.pdf", PDF);
		put(root, "d1/d2/d3/deep.pdf", PDF);
		put(base, "elsewhere/x.pdf", PDF);
		fs.symlinkSync(path.join(base, "elsewhere", "x.pdf"), path.join(root, "link.pdf"));
		const listing = await listSandbox(root, liveSandboxFs);
		assert.deepEqual(listing.items.map((f) => f.name).sort(), ["a.pdf", "d1/b.txt", "d1/d2/c.pdf"]);
		assert.equal(listing.count, 3);
		assert.equal(listing.truncated, false);
		const a = listing.items.find((f) => f.name === "a.pdf")!;
		assert.equal(a.size, PDF.byteLength);
		assert.match(a.modifiedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("at most 200 entries, and truncated says that more exist", async () => {
		const { root } = sandboxAt();
		for (let i = 0; i < 205; i++) put(root, `f${String(i).padStart(3, "0")}.pdf`, PDF);
		const listing = await listSandbox(root, liveSandboxFs);
		assert.equal(listing.items.length, 200);
		assert.equal(listing.count, 200);
		assert.equal(listing.truncated, true);
	});
});

// ---------------------------------------------------------------- the goal service

const PDF_NAMES = ["good.pdf", "good2.pdf"];

function fakeGoalsStore(): GoalsStore & { events: GoalEvent[] } {
	const events: GoalEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

/** Real sandbox reads; the document import is a fake that records the bytes and gives the nodes src_ provenance. */
function serviceDeps(root: string) {
	const graphStore = createMemoryGraphStore();
	const goalsStore = fakeGoalsStore();
	const imported: Uint8Array[] = [];
	let gateRecords = 0;
	const deps: AgentGoalsDeps = {
		graphStore,
		goalsStore,
		linksStore: {
			readLinks: () => [],
			appendLink: () => {
				throw new Error("no links in this test");
			},
		},
		gate: {
			allowed: () => true,
			reserve: () => {
				let done = false;
				return {
					commit: () => {
						if (!done) gateRecords += 1;
						done = true;
					},
					release: () => {
						done = true;
					},
				};
			},
		},
		documents: {
			async importPdf(bytes: Uint8Array) {
				imported.push(bytes);
				const sourceId = `src_doc${imported.length}`;
				const graphDeps = { graphStore, chatStore: undefined as never } as GraphDeps;
				mergeFindings(sourceId, { propositions: [{ id: "p1", name: "Document fact", statement: "The document states a fact.", aliases: [] }], chains: [] }, { links: [] }, graphDeps, { foldedAt: NOW });
				return { sourceId };
			},
		},
		sandbox: createSandboxAccess(() => root),
		now: () => NOW,
		newGoalId: () => "goal_sb1",
	};
	return { deps, graphStore, goalsStore, imported, gateRecords: () => gateRecords };
}

const goalInput = (files: unknown[]) => ({ title: "Sandbox goal", targets: ["A target statement holds."], files }) as unknown as Parameters<typeof createAgentGoal>[0];

describe("createAgentGoal attaches only sandbox files (REQ-graph-agent-23, 25)", () => {
	it("a valid sandbox file is imported like an upload, its nodes carry src_ provenance, and the sandbox file stays in place", async () => {
		const { base, root } = sandboxAt();
		const file = put(root, "book.pdf", PDF);
		const s = serviceDeps(root);
		const result = await createAgentGoal(goalInput([{ name: "book.pdf" }]), s.deps);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(s.imported.length, 1);
		assert.deepEqual(Buffer.from(s.imported[0]!), Buffer.from(PDF));
		const fileNodes = s.graphStore.readNodes().filter((n) => n.provenance.some((p) => p.chatId.startsWith("src_")));
		assert.equal(fileNodes.length, 1);
		assert.ok(result.nodeIds.includes(fileNodes[0]!.id));
		assert.equal(fs.existsSync(file), true, "the sandbox file is left in place");
		assert.ok(base.length > 0);
	});

	it("one bad name among three is a 400 naming that file, and nothing is imported or written", async () => {
		const { root } = sandboxAt();
		for (const name of PDF_NAMES) put(root, name, PDF);
		const s = serviceDeps(root);
		const result = await createAgentGoal(goalInput([{ name: "good.pdf" }, { name: "../escape.pdf" }, { name: "good2.pdf" }]), s.deps);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.status, 400);
		assert.match(result.message, /files\[1\]/);
		assert.match(result.message, /escape\.pdf/);
		assert.equal(s.imported.length, 0, "no import before every file is validated");
		assert.equal(s.goalsStore.events.length, 0);
		assert.equal(s.graphStore.readNodes().length, 0);
		assert.equal(s.gateRecords(), 0);
	});

	it("more than 5 files is a 400 with zero imports", async () => {
		const { root } = sandboxAt();
		for (let i = 0; i < 6; i++) put(root, `f${i}.pdf`, PDF);
		const s = serviceDeps(root);
		const result = await createAgentGoal(goalInput(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf` }))), s.deps);
		assert.equal(!result.ok && result.status, 400);
		assert.equal(s.imported.length, 0);
		assert.equal(s.goalsStore.events.length, 0);
	});

	it("an absolute path is refused and the 400 text carries no absolute path", async () => {
		const { base, root } = sandboxAt();
		const abs = put(root, "good.pdf", PDF);
		const s = serviceDeps(root);
		const result = await createAgentGoal(goalInput([{ name: abs }]), s.deps);
		assert.equal(!result.ok && result.status, 400);
		const message = !result.ok ? result.message : "";
		assert.ok(!message.includes(abs) && !message.includes(root) && !message.includes(base), message);
		assert.equal(s.imported.length, 0);
	});

	it("the old shape with dataBase64 is refused with 400 and nothing is written", async () => {
		const { root } = sandboxAt();
		const s = serviceDeps(root);
		const result = await createAgentGoal(goalInput([{ name: "a.pdf", dataBase64: Buffer.from(PDF).toString("base64") }]), s.deps);
		assert.equal(!result.ok && result.status, 400);
		assert.match(!result.ok ? result.message : "", /files\[0\]/);
		assert.equal(s.imported.length, 0);
		assert.equal(s.goalsStore.events.length, 0);
	});
});

describe("readAgentSandbox (REQ-graph-agent-22)", () => {
	it("returns the folder's absolute path and the page of its files", async () => {
		const { root } = sandboxAt();
		put(root, "x.pdf", PDF);
		const result = await readAgentSandbox({ sandbox: createSandboxAccess(() => root) });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.path, root);
		assert.deepEqual(result.files.items.map((f) => f.name), ["x.pdf"]);
	});

	it("creates the folder on demand with mode 0700 when it does not exist yet", async () => {
		const base = tmp();
		const root = path.join(base, "agent-sandbox");
		const result = await readAgentSandbox({ sandbox: createSandboxAccess(() => root) });
		assert.equal(result.ok, true);
		assert.equal(fs.statSync(root).mode & 0o777, 0o700);
	});
});

// ---------------------------------------------------------------- the MCP tool

describe("get_sandbox through the app port (REQ-graph-agent-22, 16)", () => {
	it("returns the path and files the app answered, and reaches the app with GET", async () => {
		const f = makeFixture();
		const seen: string[] = [];
		const reply = { path: "/data/ext/agent-sandbox", files: { items: [{ name: "a.pdf", size: 9, modifiedAt: NOW }], count: 1, truncated: false } };
		const port: AppApiPort = {
			get: async (p) => {
				seen.push(p);
				return reply;
			},
			post: async () => {
				throw new Error("no post in this test");
			},
			put: async () => {
				throw new Error("no put in this test");
			},
		};
		const out = await runTool("get_sandbox", { ...f.deps, appApi: port }, {}, { knowledgeOnly: false });
		assert.deepEqual(out, reply);
		assert.deepEqual(seen, ["/api/ext/agent/sandbox"]);
	});

	it("is registered in the write group, is read-only by annotation, and is disabled under --knowledge-only", async () => {
		assert.equal(toolGroup("get_sandbox"), "write");
		assert.equal(toolReadOnly("get_sandbox"), true);
		assert.equal(toolReadOnly("create_goal"), false);
		const f = makeFixture();
		let called = false;
		const port: AppApiPort = {
			get: async () => {
				called = true;
				return {};
			},
			post: async () => ({}),
			put: async () => ({}),
		};
		assert.throws(() => runTool("get_sandbox", { ...f.deps, appApi: port }, {}, { knowledgeOnly: true }), (e: unknown) => e instanceof ToolError && e.code === "disabled");
		assert.equal(called, false);
	});
});

describe("the MCP module performs no file system reads (REQ-graph-agent-23)", () => {
	it("write.ts imports neither node:fs nor node:path, so create_goal cannot read a local file", () => {
		const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "core", "ext", "mcp", "write.ts"), "utf-8");
		assert.doesNotMatch(source, /from\s+["'](node:)?fs(\/promises)?["']/);
		assert.doesNotMatch(source, /from\s+["'](node:)?path["']/);
	});
});

describe("the sandbox file is read through one descriptor (REQ-graph-agent-24, no check-then-read)", () => {
	async function reader() {
		return (await import("../src/server/ext/sandbox-live.ts")).readSandboxFile;
	}

	it("a regular file is read whole, from the descriptor it was opened with", async () => {
		const { root } = sandboxAt();
		const file = put(root, "whole.pdf", PDF);
		const result = await (await reader())(file);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PDF));
	});

	it("a path that is a symbolic link at open time is refused (O_NOFOLLOW, ELOOP)", async () => {
		const { base, root } = sandboxAt();
		const target = put(base, "target/real.pdf", PDF);
		const link = path.join(root, "swapped.pdf");
		fs.symlinkSync(target, link);
		const result = await (await reader())(link);
		assert.equal(result.ok, false);
	});

	it("a directory is refused: the descriptor is not a regular file", async () => {
		const { root } = sandboxAt();
		const dir = path.join(root, "folder.pdf");
		fs.mkdirSync(dir);
		const result = await (await reader())(dir);
		assert.equal(result.ok, false);
	});

	it("a file that grows past the 20 MB cap while it is being read is refused", async () => {
		const { root } = sandboxAt();
		const file = put(root, "grows.pdf", Buffer.concat([Buffer.from(PDF), Buffer.alloc(64 * 1024, 0x20)]));
		let grown = false;
		const result = await (await reader())(file, {
			chunkBytes: 16 * 1024,
			afterChunk: () => {
				if (grown) return;
				grown = true;
				fs.truncateSync(file, SANDBOX_MAX_FILE_BYTES + 1);
			},
		});
		assert.equal(result.ok, false);
		assert.equal(grown, true, "the file did grow while being read");
	});

	it("a file over the cap when it is opened is refused by size, before any bytes are read", async () => {
		const { root } = sandboxAt();
		const big = put(root, "opened-big.pdf", PDF);
		fs.truncateSync(big, SANDBOX_MAX_FILE_BYTES + 1);
		const result = await (await reader())(big);
		assert.equal(result.ok, false);
	});
});
