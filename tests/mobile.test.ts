import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { keyboardInset, MOBILE_BREAKPOINT_PX, MOBILE_QUERY, sidebarPresentation, firstShownMessage, PHONE_MESSAGE_WINDOW, TOUCH_TARGET_PX } from "../components/mobile.ts";

test("the breakpoint is 768 and the query is the one Tailwind's max-md uses", () => {
	assert.equal(MOBILE_BREAKPOINT_PX, 768);
	assert.equal(MOBILE_QUERY, "(max-width: 767.98px)");
	assert.equal(TOUCH_TARGET_PX, 44);
});

test("globals.css uses the same phone media query and touch size as mobile.ts", () => {
	const css = fs.readFileSync(path.resolve(import.meta.dirname, "../app/globals.css"), "utf8");
	assert(css.includes(`@media ${MOBILE_QUERY}`), "phone media query missing or different");
	assert(css.includes(`--lh-touch: ${TOUCH_TARGET_PX}px`), "touch size variable missing or different");
});

test("keyboardInset is the covered strip at the bottom, never negative", () => {
	assert.equal(keyboardInset(800, 800, 0), 0);
	assert.equal(keyboardInset(800, 500, 0), 300);
	assert.equal(keyboardInset(800, 500, 20), 280);
	assert.equal(keyboardInset(800, 900, 0), 0);
	assert.equal(keyboardInset(800, 499.6, 0), 300);
});

test("on a phone the sidebar is an overlay that follows only the drawer flag", () => {
	for (const pref of [true, false]) for (const narrow of [true, false]) {
		assert.deepEqual(sidebarPresentation({ mobile: true, pref, narrow, mobileOpen: false }), { open: false, overlay: true });
		assert.deepEqual(sidebarPresentation({ mobile: true, pref, narrow, mobileOpen: true }), { open: true, overlay: true });
	}
});

test("above the breakpoint nothing changes: open is the saved choice unless the window is narrow", () => {
	for (const mobileOpen of [true, false]) {
		assert.deepEqual(sidebarPresentation({ mobile: false, pref: true, narrow: false, mobileOpen }), { open: true, overlay: false });
		assert.deepEqual(sidebarPresentation({ mobile: false, pref: true, narrow: true, mobileOpen }), { open: false, overlay: false });
		assert.deepEqual(sidebarPresentation({ mobile: false, pref: false, narrow: false, mobileOpen }), { open: false, overlay: false });
	}
});

test("on a phone form fields are never smaller than 16px, so Safari does not zoom on focus", () => {
	const css = fs.readFileSync(path.resolve(import.meta.dirname, "../app/globals.css"), "utf8");
	const phone = css.slice(css.indexOf(`@media ${MOBILE_QUERY}`));
	assert(/input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*max\(16px,\s*1em\)/.test(phone));
});

test("a phone draws only the newest messages of a long transcript; a computer draws all of them", () => {
	assert.equal(firstShownMessage(false, 5000, PHONE_MESSAGE_WINDOW), 0);
	assert.equal(firstShownMessage(true, 5000, PHONE_MESSAGE_WINDOW), 5000 - PHONE_MESSAGE_WINDOW);
	assert.equal(firstShownMessage(true, 10, PHONE_MESSAGE_WINDOW), 0, "a short chat is shown whole");
	assert.equal(firstShownMessage(true, PHONE_MESSAGE_WINDOW, PHONE_MESSAGE_WINDOW), 0, "exactly the window shows no 'earlier' button");
	assert.equal(firstShownMessage(true, 100, 100 + PHONE_MESSAGE_WINDOW), 0, "asking for more than exists shows all");
	assert.equal(firstShownMessage(true, 0, PHONE_MESSAGE_WINDOW), 0, "an empty chat");
});
