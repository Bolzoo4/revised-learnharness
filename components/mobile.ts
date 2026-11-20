import { useEffect, useSyncExternalStore } from "react";

/** The one phone breakpoint: Tailwind's `md`. Below it the shell is a phone shell. */
export const MOBILE_BREAKPOINT_PX = 768;
/** Same range as Tailwind's `max-md`; app/globals.css repeats it and tests/mobile.test.ts checks they match. */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px)`;
/** Minimum hit area for a shell control on a phone (Apple's guideline). */
/** How many of the newest messages a phone draws before the reader asks for earlier ones. */
export const PHONE_MESSAGE_WINDOW = 30;
/** Index of the first message to draw: all of them when not windowed, else only the newest `shown`. */
export function firstShownMessage(windowed: boolean, total: number, shown: number): number {
	return windowed ? Math.max(0, total - shown) : 0;
}
export const TOUCH_TARGET_PX = 44;

const canMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribe(onChange: () => void): () => void {
	if (!canMatchMedia()) return () => {};
	const query = window.matchMedia(MOBILE_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True below the breakpoint. Server render, first client render and environments without matchMedia say false. */
export function useIsMobile(): boolean {
	return useSyncExternalStore(subscribe, () => canMatchMedia() && window.matchMedia(MOBILE_QUERY).matches, () => false);
}

/** The strip at the bottom of the layout viewport that the on-screen keyboard covers. */
export function keyboardInset(innerHeight: number, viewportHeight: number, viewportOffsetTop: number): number {
	return Math.max(0, Math.round(innerHeight - viewportHeight - viewportOffsetTop));
}

/**
 * How the sidebar shows. @post on a phone `open` is the drawer flag and the sidebar overlays the page;
 * otherwise `open` is the saved choice unless the (Electron) window is narrow, as before.
 */
export function sidebarPresentation(input: { mobile: boolean; pref: boolean; narrow: boolean; mobileOpen: boolean }): { open: boolean; overlay: boolean } {
	if (input.mobile) return { open: input.mobileOpen, overlay: true };
	return { open: input.pref && !input.narrow, overlay: false };
}

/**
 * Keep `--lh-vvh` (the visible height) and `--lh-kb` (keyboard height) on <html> while `enabled`, so a
 * phone layout can sit above the iOS keyboard; clears them otherwise. iOS scrolls the page when the keyboard
 * opens, so the page is put back at the top whenever the keyboard is up.
 */
export function useVisualViewportVars(enabled: boolean): void {
	useEffect(() => {
		const root = document.documentElement;
		const viewport = window.visualViewport;
		if (!enabled || !viewport) return;
		const update = () => {
			const inset = keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop);
			root.style.setProperty("--lh-vvh", `${Math.round(viewport.height)}px`);
			root.style.setProperty("--lh-kb", `${inset}px`);
			if (inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			root.style.removeProperty("--lh-vvh");
			root.style.removeProperty("--lh-kb");
		};
	}, [enabled]);
}
