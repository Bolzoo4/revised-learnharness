/** Backend title isolation without launching Electron or touching a user profile. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const guardSource = readFileSync(path.join(root, "electron/server-title-guard.cjs"), "utf8");
const backendEnv = { ELECTRON_RUN_AS_NODE: "1", LH_DESKTOP_SERVER: "1" };

function titleFixture(platform = "darwin", env: Record<string, string> = backendEnv) {
	const nativeWrites: unknown[] = [];
	let nativeReads = 0;
	const process = { platform, env } as { platform: string; env: Record<string, string>; title: unknown };
	Object.defineProperty(process, "title", {
		configurable: true, enumerable: true,
		get() { nativeReads++; return "initial native title"; },
		set(value) { nativeWrites.push(value); },
	});
	const original = Object.getOwnPropertyDescriptor(process, "title");
	runInNewContext(guardSource, { process });
	return { process, nativeWrites, original, nativeReads: () => nativeReads };
}

describe("macOS backend process.title guard", () => {
	it("reads the initial title once, then isolates strict-mode writes from the native setter", () => {
		const fixture = titleFixture();
		assert.equal(fixture.nativeReads(), 1);
		assert.equal(fixture.process.title, "initial native title");
		runInNewContext('"use strict"; process.title = "next-server (v16.3.2)";', { process: fixture.process });
		assert.equal(fixture.process.title, "next-server (v16.3.2)");
		fixture.process.title = "next-router-worker";
		assert.equal(fixture.process.title, "next-router-worker");
		assert.deepEqual(fixture.nativeWrites, []);
		assert.equal(fixture.nativeReads(), 1);
		const descriptor = Object.getOwnPropertyDescriptor(fixture.process, "title")!;
		assert.equal(typeof descriptor.get, "function");
		assert.equal(typeof descriptor.set, "function");
		assert.equal(descriptor.configurable, true);
		assert.equal(descriptor.enumerable, true);
	});

	it("uses the approved String(value) contract, without native length truncation", () => {
		const fixture = titleFixture();
		for (const value of [42, true, null, undefined, Symbol("title"), "x".repeat(4096)]) {
			fixture.process.title = value;
			assert.equal(fixture.process.title, String(value));
		}
		let coercions = 0;
		fixture.process.title = { toString() { coercions++; return "custom title"; } };
		assert.equal(fixture.process.title, "custom title");
		assert.equal(coercions, 1);
		assert.throws(() => { fixture.process.title = { toString() { throw new Error("conversion failed"); } }; }, /conversion failed/);
		assert.equal(fixture.process.title, "custom title");
		assert.deepEqual(fixture.nativeWrites, []);
	});

	it("can be loaded again without restoring the native accessor", () => {
		const fixture = titleFixture();
		fixture.process.title = "remembered";
		runInNewContext(guardSource, { process: fixture.process });
		assert.equal(fixture.process.title, "remembered");
		fixture.process.title = "next-server";
		assert.deepEqual(fixture.nativeWrites, []);
		assert.equal(fixture.nativeReads(), 1);
	});

	for (const [label, platform, env] of [
		["Windows", "win32", backendEnv],
		["Linux", "linux", backendEnv],
		["full-Electron browser helper", "darwin", {}],
		["non-backend Node child", "darwin", { ELECTRON_RUN_AS_NODE: "1" }],
		["non-Node-mode process", "darwin", { LH_DESKTOP_SERVER: "1" }],
	] as const) {
		it(`leaves the original property untouched for ${label}`, () => {
			const fixture = titleFixture(platform, env);
			assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.process, "title"), fixture.original);
			assert.equal(fixture.nativeReads(), 0);
			assert.deepEqual(fixture.nativeWrites, []);
		});
	}
});

describe("backend-only preload wiring and packaging", () => {
	it("electron-builder copies the guard outside ASAR only on macOS, retaining shared resources", async () => {
		const yaml = require("js-yaml");
		const config = yaml.load(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
		const { getFileMatchers, copyFiles } = require("app-builder-lib/out/fileMatcher.js");
		const destination = mkdtempSync(path.join(tmpdir(), "lh-title-resource-"));
		try {
			for (const platform of ["mac", "win", "linux"]) {
				const matchers = getFileMatchers(config, "extraResources", destination, {
					defaultSrc: root, customBuildOptions: config[platform], macroExpander: (value: string) => value,
					globalOutDir: path.join(root, "dist"),
				});
				assert.ok(matchers.some((matcher: { to: string }) => matcher.to === path.join(destination, "server")), "shared standalone payload remains included");
				const guards = matchers.filter((matcher: { to: string }) => matcher.to === path.join(destination, "server-title-guard.cjs"));
				assert.equal(guards.length, platform === "mac" ? 1 : 0);
				if (platform === "mac") {
					await copyFiles(guards, null, false);
					assert.equal(readFileSync(path.join(destination, "server-title-guard.cjs"), "utf8"), guardSource);
				}
			}
		} finally {
			rmSync(destination, { recursive: true, force: true });
		}
	});
});
