import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import manifest from "../app/manifest.ts";

const root = path.resolve(import.meta.dirname, "..");

test("the manifest describes an installable standalone app with all three icon kinds", () => {
	const m = manifest();
	assert.equal(m.name, "LearnHarness");
	assert.ok(m.short_name && m.short_name.length <= 12);
	assert.equal(m.start_url, "/");
	assert.equal(m.display, "standalone");
	assert.equal(m.background_color, "#141414");
	assert.equal(m.theme_color, "#141414");
	const icons = m.icons ?? [];
	assert(icons.some((i) => i.sizes === "192x192" && i.purpose === "any"));
	assert(icons.some((i) => i.sizes === "512x512" && i.purpose === "any"));
	assert(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
});

test("every icon the manifest names exists on disk with the declared size", () => {
	for (const icon of manifest().icons ?? []) {
		const file = path.join(root, "public", icon.src);
		assert(fs.existsSync(file), icon.src);
		const buffer = fs.readFileSync(file);
		assert.equal(buffer.readUInt32BE(16), Number(icon.sizes?.split("x")[0]), `${icon.src} width`);
	}
	assert(fs.existsSync(path.join(root, "public/apple-touch-icon.png")));
	assert.equal(fs.readFileSync(path.join(root, "public/apple-touch-icon.png")).readUInt32BE(16), 180);
});

test("the app registers no service worker", () => {
	assert(!fs.existsSync(path.join(root, "public/sw.js")));
	const dirs = ["app", "components"];
	const hits: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(tsx?|jsx?)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("serviceWorker.register")) hits.push(full);
		}
	};
	for (const dir of dirs) walk(path.join(root, dir));
	assert.deepEqual(hits, []);
});

test("the root layout asks for edge-to-edge display and an Apple standalone app", () => {
	const layout = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
	assert(/viewportFit:\s*"cover"/.test(layout));
	assert(/themeColor:\s*"#141414"/.test(layout));
	assert(/appleWebApp/.test(layout) && /capable:\s*true/.test(layout));
	assert(/apple-touch-icon\.png/.test(layout));
});
