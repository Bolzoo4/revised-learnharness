// tests/ext-theme.test.ts
// Light theme: the pure half (mode resolution, the dark-class switch on <html>,
// the pre-paint bootstrap), the appearance mapping in light mode, and a guard
// that the light palette mirrors every dark token and keeps readable contrast.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	applyThemeClass,
	DARK_CLASS,
	resolveThemeMode,
	THEME_BOOTSTRAP_SCRIPT,
	THEME_CACHE_KEY,
} from "../src/core/ext/theme.ts";
import { FACTORY_SETTINGS } from "../src/core/settings.ts";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";

/** A minimal DOMTokenList stand-in: toggle(token, force) like the real one. */
function fakeClassList(initial: string[]) {
	const set = new Set(initial);
	return {
		set,
		remove(...tokens: string[]): void {
			for (const t of tokens) set.delete(t);
		},
		toggle(token: string, force?: boolean): boolean {
			const on = force ?? !set.has(token);
			if (on) set.add(token);
			else set.delete(token);
			return on;
		},
	};
}

describe("resolveThemeMode — default dark, only the two modes pass", () => {
	it("absent or unknown input resolves to the factory mode (dark)", () => {
		assert.equal(resolveThemeMode(undefined), FACTORY_SETTINGS.appearance.mode);
		assert.equal(resolveThemeMode(undefined), "dark");
		assert.equal(resolveThemeMode("sepia"), "dark");
		assert.equal(resolveThemeMode(null), "dark");
	});

	it("dark and light pass through unchanged", () => {
		assert.equal(resolveThemeMode("dark"), "dark");
		assert.equal(resolveThemeMode("light"), "light");
	});
});

describe("applyThemeClass — the dark class is the switch", () => {
	it("dark keeps the class on <html>; light removes it", () => {
		const cl = fakeClassList([]);
		applyThemeClass(cl, "dark");
		assert.ok(cl.set.has(DARK_CLASS));
		applyThemeClass(cl, "light");
		assert.ok(!cl.set.has(DARK_CLASS));
	});

	it("keeps unrelated classes (the font variables ride on the same element)", () => {
		const cl = fakeClassList(["__variable_1", "dark"]);
		applyThemeClass(cl, "light");
		assert.deepEqual([...cl.set], ["__variable_1"]);
	});

	it("is idempotent", () => {
		const cl = fakeClassList([]);
		applyThemeClass(cl, "light");
		applyThemeClass(cl, "light");
		assert.ok(!cl.set.has(DARK_CLASS));
		applyThemeClass(cl, "dark");
		applyThemeClass(cl, "dark");
		assert.equal([...cl.set].filter((c) => c === DARK_CLASS).length, 1);
	});

	it("the class name is `dark` — the variant and streamdown's code highlighting read it", () => {
		assert.equal(DARK_CLASS, "dark");
	});
});

describe("THEME_BOOTSTRAP_SCRIPT — applied before first paint, no flash", () => {
	/** Runs the inline script against fake document + localStorage. */
	function runBootstrap(stored: string | null | "throw", initialClasses: string[]): string[] {
		const cl = fakeClassList(initialClasses);
		const doc = { documentElement: { classList: cl } };
		const storage = {
			getItem(key: string): string | null {
				assert.equal(key, THEME_CACHE_KEY, "reads the one cache key");
				if (stored === "throw") throw new Error("storage denied");
				return stored;
			},
		};
		new Function("document", "localStorage", THEME_BOOTSTRAP_SCRIPT)(doc, storage);
		return [...cl.set];
	}

	it("a cached light removes the dark class before the page paints", () => {
		assert.deepEqual(runBootstrap("light", ["dark", "__variable_1"]), ["__variable_1"]);
	});

	it("a cached dark, or no cache, leaves the server-rendered dark class alone", () => {
		assert.deepEqual(runBootstrap("dark", ["dark"]), ["dark"]);
		assert.deepEqual(runBootstrap(null, ["dark"]), ["dark"]);
	});

	it("a denied storage (the accessor throws) never throws out and keeps the dark default", () => {
		assert.deepEqual(runBootstrap("throw", ["dark"]), ["dark"]);
	});
});

describe("appearanceVars — light mode has its own palette", () => {
	it("in light mode a stored background sets no palette variables (the dark curve is not applied)", () => {
		const vars = appearanceVars(resolveAppearance({ mode: "light", background: "#101010" }));
		assert.equal(vars["--background"], undefined);
		assert.equal(vars["--card"], undefined);
		assert.equal(vars["--border"], undefined);
	});

	it("in dark mode the background curve is unchanged", () => {
		const vars = appearanceVars(resolveAppearance({ mode: "dark", background: "#101820" }));
		assert.equal(vars["--background"], "#101820");
		assert.equal(vars["--card"], "#182028");
	});
});

describe("app/globals.css — the light palette", () => {
	const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

	/** The body of the first top-level rule whose selector text is `selector {`. */
	function ruleBody(selector: string): string {
		const start = css.indexOf(`${selector} {`);
		assert.ok(start >= 0, `rule ${selector} exists`);
		const end = css.indexOf("\n}", start);
		return css.slice(start, end);
	}
	function declared(body: string): Map<string, string> {
		const out = new Map<string, string>();
		for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+?);/gm)) out.set(m[1]!, m[2]!.trim());
		return out;
	}
	// Sizes, radii and weights are not colours: the light block restates only colour tokens.
	const NON_COLOUR = new Set(["--radius", "--lh-prose-size", "--lh-prose-leading", "--lh-heading-weight"]);

	const dark = declared(ruleBody(":root"));
	const light = declared(ruleBody(":root:not(.dark)"));

	it("every colour token the dark palette defines is defined for light too", () => {
		const missing = [...dark.keys()].filter((n) => !NON_COLOUR.has(n) && !light.has(n));
		assert.deepEqual(missing, []);
	});

	it("light declares color-scheme: light and dark keeps color-scheme: dark (native scrollbars follow)", () => {
		assert.match(ruleBody(":root:not(.dark)"), /color-scheme:\s*light/);
		assert.match(ruleBody(":root"), /color-scheme:\s*dark/);
	});

	it("light is soft: an off-white page, not pure white, and dark grey text", () => {
		assert.equal(light.get("--background"), "#f6f4ef");
		assert.notEqual(light.get("--foreground"), "#000000");
		assert.notEqual(light.get("--background"), "#ffffff");
	});

	it("readable contrast on the light surfaces (WCAG: 7:1 body text, 4.5:1 secondary text)", () => {
		const bg = light.get("--background")!;
		assert.ok(contrast(light.get("--foreground")!, bg) >= 7, "foreground on background");
		assert.ok(contrast(light.get("--card-foreground")!, light.get("--card")!) >= 7, "card text");
		assert.ok(contrast(light.get("--muted-foreground")!, bg) >= 4.5, "muted text on background");
		assert.ok(contrast(light.get("--primary-foreground")!, light.get("--primary")!) >= 7, "primary button text");
	});
});

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function luminance(hex: string): number {
	assert.match(hex, /^#[0-9a-f]{6}$/i, `expected #rrggbb, got ${hex}`);
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
