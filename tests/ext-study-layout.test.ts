// tests/ext-study-layout.test.ts
// The study view's pure rules: which pages are on screen, the page stack and its window,
// the split ratio, zoom steps, and the saved layout (garbage in, defaults out).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampRatio,
	DEFAULT_LAYOUT,
	DEFAULT_SPLIT_RATIO,
	EXTRA_PAGE_SHARE,
	LAYOUT_KEY,
	MIN_PANE_PX,
	parseLayoutPrefs,
	ratioFromPointer,
	readLayoutPrefs,
	renderWindow,
	SPLIT_STEP,
	splitBounds,
	splitStep,
	stackPages,
	stepZoom,
	visiblePages,
	writeLayoutPrefs,
	ZOOM_STEPS,
	type PageRect,
} from "../components/ext/study-logic.ts";

/** Pages of height 100 stacked with no gap, page 1 at top 0. */
const stack = (n: number, h = 100): PageRect[] => Array.from({ length: n }, (_, i) => ({ page: i + 1, top: i * h, height: h }));

describe("visiblePages", () => {
	it("one page on screen: it is the primary and there are no others", () => {
		const r = visiblePages(stack(1), { top: 0, height: 80 });
		assert.deepEqual(r, { primary: 1, others: [] });
	});

	it("two pages on screen: the one with more visible pixels is primary, the other is listed", () => {
		// viewport 40..140: page 1 shows 60 px, page 2 shows 40 px
		const r = visiblePages(stack(3), { top: 40, height: 100 });
		assert.equal(r.primary, 1);
		assert.deepEqual(r.others, [2]);
	});

	it("three pages on screen: all three are listed, ordered by page number, capped at three in total", () => {
		const r = visiblePages(stack(6), { top: 50, height: 300 });
		assert.equal(r.primary, 2);
		assert.deepEqual(r.others, [1, 3]);
		assert.equal([r.primary!, ...r.others].length, 3);
	});

	it("more candidates than the cap: the two strongest others are kept, the rest dropped", () => {
		// A 1000 px viewport from 90 over ten 100 px pages: page 1 shows 10 px, pages 2..10 are whole on screen.
		// The tie among the whole pages goes to the lower page, so page 2 is primary and pages 3 and 4 are the strongest others.
		const rects = stack(10);
		const r = visiblePages(rects, { top: 90, height: 1000 });
		assert.equal(r.primary, 2);
		assert.equal(r.others.length, 2);
		assert.ok(r.others.every((p) => p !== 2));
		assert.ok(r.others.every((p, i, all) => i === 0 || p > all[i - 1]!), "ascending");
	});

	it("a page with a sliver visible is not listed when less than the share of its height or the viewport shows", () => {
		// page 2 shows 5 px of 100 (5%), viewport 1000 px tall: 5 < 20% of both
		const sliver = visiblePages(stack(3), { top: 0, height: 205 });
		assert.equal(sliver.primary, 1);
		assert.deepEqual(sliver.others, [2]);
		assert.ok(!sliver.others.includes(3), "5 px of page 3 is below the share");
	});

	it("a page shows at least the share of its own height", () => {
		const threshold = EXTRA_PAGE_SHARE * 100; // 20 px of a 100 px page
		const r = visiblePages(stack(2), { top: 0, height: 100 + threshold });
		assert.deepEqual(r.others, [2]);
	});

	it("the viewport is not in any page: nothing is primary", () => {
		assert.deepEqual(visiblePages(stack(2), { top: 500, height: 100 }), { primary: null, others: [] });
	});

	it("an empty document, or a zero-height viewport, shows no page", () => {
		assert.deepEqual(visiblePages([], { top: 0, height: 800 }), { primary: null, others: [] });
		assert.deepEqual(visiblePages(stack(2), { top: 0, height: 0 }), { primary: null, others: [] });
	});

	it("a page with no height is ignored, and a tie for the largest share goes to the lower page", () => {
		const rects: PageRect[] = [
			{ page: 1, top: 0, height: 0 },
			{ page: 2, top: 0, height: 100 },
			{ page: 3, top: 100, height: 100 },
		];
		const r = visiblePages(rects, { top: 50, height: 100 });
		assert.equal(r.primary, 2);
		assert.deepEqual(r.others, [3]);
	});
});

describe("stackPages", () => {
	it("stacks pages with the gap, each height from its ratio and the width", () => {
		const s = stackPages([1.5, 2], 100, 10);
		assert.deepEqual(s.tops, [10, 10 + 150 + 10]);
		assert.deepEqual(s.heights, [150, 200]);
		assert.equal(s.total, 10 + 150 + 10 + 200 + 10);
	});

	it("a bad ratio falls back to an A4-like shape instead of collapsing the page", () => {
		const s = stackPages([0, Number.NaN], 100, 0);
		assert.ok(s.heights.every((h) => Math.abs(h - 100 * Math.SQRT2) < 1e-9));
	});
});

describe("renderWindow", () => {
	it("keeps the pages on screen and two more on each side", () => {
		const rects = stack(300);
		assert.deepEqual(renderWindow(rects, { top: 5000, height: 200 }, 2), { first: 50 + 1 - 2, last: 52 + 2 });
	});

	it("is clamped at the first and last page", () => {
		assert.deepEqual(renderWindow(stack(5), { top: 0, height: 100 }, 2), { first: 1, last: 3 });
		assert.deepEqual(renderWindow(stack(5), { top: 390, height: 100 }, 2), { first: 2, last: 5 });
	});

	it("before the layout is measured (zero height) the first pages are kept; an empty document keeps none", () => {
		assert.deepEqual(renderWindow(stack(10), { top: 0, height: 0 }, 2), { first: 1, last: 3 });
		assert.equal(renderWindow([], { top: 0, height: 800 }, 2), null);
	});
});

describe("split ratio", () => {
	it("bounds keep both panes at the minimum width", () => {
		const { lo, hi } = splitBounds(1000);
		assert.equal(lo, MIN_PANE_PX / 1000);
		assert.equal(hi, 1 - MIN_PANE_PX / 1000);
	});

	it("no room for two minimum panes: the ratio is fixed at one half", () => {
		assert.deepEqual(splitBounds(2 * MIN_PANE_PX - 1), { lo: 0.5, hi: 0.5 });
		assert.equal(clampRatio(0.9, 0), 0.5);
	});

	it("clampRatio clamps a value to the bounds and replaces non-numbers with the default", () => {
		assert.equal(clampRatio(0.01, 1000), MIN_PANE_PX / 1000);
		assert.equal(clampRatio(0.99, 1000), 1 - MIN_PANE_PX / 1000);
		assert.equal(clampRatio(0.5, 1000), 0.5);
		assert.equal(clampRatio(Number.NaN, 1000), DEFAULT_SPLIT_RATIO);
		assert.equal(clampRatio("0.3", 1000), DEFAULT_SPLIT_RATIO);
		assert.equal(clampRatio(Infinity, 1000), DEFAULT_SPLIT_RATIO);
	});

	it("the pointer gives the pane share of the container, clamped", () => {
		assert.equal(ratioFromPointer(300 + 500, 300, 1000), 0.5);
		assert.equal(ratioFromPointer(0, 300, 1000), MIN_PANE_PX / 1000, "dragged past the left edge");
		assert.equal(ratioFromPointer(5000, 0, 1000), 1 - MIN_PANE_PX / 1000, "dragged past the right edge");
		assert.equal(ratioFromPointer(10, 0, 0), DEFAULT_SPLIT_RATIO, "no width yet");
	});

	it("arrow keys step, Home and End go to the bounds, other keys are not handled", () => {
		const w = 1000;
		assert.equal(splitStep(0.6, "ArrowRight", w), 0.6 + SPLIT_STEP);
		assert.equal(splitStep(0.6, "ArrowLeft", w), 0.6 - SPLIT_STEP);
		assert.equal(splitStep(0.6, "Home", w), MIN_PANE_PX / w);
		assert.equal(splitStep(0.6, "End", w), 1 - MIN_PANE_PX / w);
		assert.equal(splitStep(0.6, "a", w), null);
		assert.equal(splitStep(0.6, "Enter", w), null);
	});

	it("a step past a bound stops at the bound", () => {
		const lo = MIN_PANE_PX / 1000;
		assert.equal(splitStep(lo, "ArrowLeft", 1000), lo);
	});
});

describe("zoom", () => {
	it("steps through the zoom list and stops at the ends", () => {
		assert.equal(stepZoom(1, 1), 1.25);
		assert.equal(stepZoom(1, -1), 0.75);
		assert.equal(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1]!, 1), ZOOM_STEPS[ZOOM_STEPS.length - 1]);
		assert.equal(stepZoom(ZOOM_STEPS[0]!, -1), ZOOM_STEPS[0]);
	});

	it("a zoom between two steps moves to the neighbouring step", () => {
		assert.equal(stepZoom(1.1, 1), 1.25);
		assert.equal(stepZoom(1.1, -1), 1);
	});
});

describe("saved layout", () => {
	it("a valid saved layout is read as written", () => {
		assert.deepEqual(parseLayoutPrefs(JSON.stringify({ ratio: 0.45, chatOpen: false })), { ratio: 0.45, chatOpen: false });
	});

	it("garbage falls back per field, never throws", () => {
		const garbage: unknown[] = [
			null,
			undefined,
			"",
			"not json",
			"[]",
			"42",
			"null",
			JSON.stringify("text"),
			JSON.stringify([1, 2]),
			JSON.stringify({}),
			JSON.stringify({ ratio: "0.3", chatOpen: "no" }),
			JSON.stringify({ ratio: 0, chatOpen: 1 }),
			JSON.stringify({ ratio: 1, chatOpen: null }),
			JSON.stringify({ ratio: -0.2 }),
			JSON.stringify({ ratio: 7 }),
			JSON.stringify({ ratio: 1e400 }),
		];
		for (const raw of garbage) {
			const p = parseLayoutPrefs(raw);
			assert.ok(Number.isFinite(p.ratio) && p.ratio > 0 && p.ratio < 1, `ratio of ${String(raw)}`);
			assert.equal(typeof p.chatOpen, "boolean", `chatOpen of ${String(raw)}`);
		}
		assert.deepEqual(parseLayoutPrefs("not json"), DEFAULT_LAYOUT);
		assert.deepEqual(parseLayoutPrefs(JSON.stringify({ ratio: "x" })), { ratio: DEFAULT_LAYOUT.ratio, chatOpen: true });
		assert.deepEqual(parseLayoutPrefs(JSON.stringify({ ratio: 0.3, chatOpen: "no" })), { ratio: 0.3, chatOpen: true });
	});

	it("a storage that throws on access gives the defaults, and a write to it is ignored", () => {
		const throwing = () => {
			throw new Error("SecurityError");
		};
		assert.deepEqual(readLayoutPrefs(throwing), DEFAULT_LAYOUT);
		assert.doesNotThrow(() => writeLayoutPrefs(throwing, { ratio: 0.4, chatOpen: false }));
	});

	it("a storage whose getItem throws gives the defaults; a value written is read back by key", () => {
		const bad = { getItem: () => { throw new Error("denied"); } };
		assert.deepEqual(readLayoutPrefs(() => bad), DEFAULT_LAYOUT);
		const kept = new Map<string, string>();
		const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
		writeLayoutPrefs(() => store, { ratio: 0.4, chatOpen: false });
		assert.ok(kept.has(LAYOUT_KEY));
		assert.deepEqual(readLayoutPrefs(() => store), { ratio: 0.4, chatOpen: false });
	});
});
