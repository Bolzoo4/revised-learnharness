// tests/service-pair.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const darwin = process.platform === "darwin";
const TOKEN = "t".repeat(64);
const CODE = "AbCdEfGhIjKlMnOpQrStUv";

function runScript(env: Record<string, string>) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn("bash", [path.join(ROOT, "scripts/service/pair.sh")], { env: env as unknown as NodeJS.ProcessEnv });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

async function withServer(handler: http.RequestListener, body: (port: number) => Promise<void>) {
	const server = http.createServer(handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try { await body((server.address() as { port: number }).port); } finally { server.close(); }
}

function home(withHost: boolean) {
	const h = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pair-sh-"));
	const support = path.join(h, "Library/Application Support/LearnHarness");
	fs.mkdirSync(support, { recursive: true });
	fs.writeFileSync(path.join(support, "access-token"), TOKEN, { mode: 0o600 });
	if (withHost) fs.writeFileSync(path.join(support, "tailnet-host"), "mac.tail1234.ts.net:8444");
	return h;
}

test("pair.sh signs in on loopback, asks for a code and prints the pairing URL without the token", { skip: !darwin }, async () => {
	const seen: string[] = [];
	await withServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			seen.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ""} origin=${req.headers.origin ?? ""}`);
			if (req.url === "/api/access/signin") { assert(body.includes(TOKEN)); res.setHeader("set-cookie", "lh_session=abc; Path=/; HttpOnly"); res.end("{}"); }
			else if (req.url === "/api/access/pairing") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: CODE, expiresAt: Date.now() + 300000 })); }
			else { res.statusCode = 404; res.end(); }
		});
	}, async (port) => {
		const result = await runScript({ PATH: process.env.PATH!, HOME: home(true), LH_PORT: String(port) });
		assert.equal(result.status, 0, result.stderr);
		assert(result.stdout.includes(`https://mac.tail1234.ts.net:8444/pair#${CODE}`), result.stdout);
		assert(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
		assert(seen[0]?.startsWith("POST /api/access/signin"), seen.join("\n"));
		assert(seen[1]?.includes("cookie=lh_session=abc") && seen[1].includes(`origin=http://127.0.0.1:${port}`), seen.join("\n"));
	});
});

test("pair.sh asks for serve.sh first when nothing is published", { skip: !darwin }, async () => {
	const result = await runScript({ PATH: process.env.PATH!, HOME: home(false), LH_PORT: "1" });
	assert.notEqual(result.status, 0);
	assert(/serve\.sh on/.test(result.stderr), result.stderr);
});

test("pair.sh fails clearly when the service refuses the sign-in", { skip: !darwin }, async () => {
	await withServer((_req, res) => { res.statusCode = 401; res.end("{}"); }, async (port) => {
		const result = await runScript({ PATH: process.env.PATH!, HOME: home(true), LH_PORT: String(port) });
		assert.notEqual(result.status, 0);
		assert(!result.stdout.includes("/pair#"));
		assert(!result.stderr.includes(TOKEN));
	});
});
