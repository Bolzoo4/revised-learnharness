// src/core/ext/theme.ts
/**
 * Light theme, the pure half: mode resolution, the dark-class switch on
 * <html>, and the pre-paint bootstrap script. The palettes are CSS
 * (app/globals.css); the persisted choice is the appearance section's
 * `mode` (core/settings.ts, already in the schema and the sanitizer).
 *
 * The switch is the `dark` class on <html>: the Tailwind `dark:` variant
 * and streamdown's shiki dark variables both read it, so one class keeps
 * every dark-aware piece of the app in step.
 */
import { FACTORY_SETTINGS } from "../settings.ts";

export type ThemeMode = "dark" | "light";

/** The class that means dark. Present on <html> = dark, absent = light. */
export const DARK_CLASS = "dark";

/** localStorage key mirroring the resolved mode, read before first paint.
 *  A per-viewer convenience only: the settings record stays the truth. */
export const THEME_CACHE_KEY = "lh-theme-mode";

/** The mode a value resolves to: "dark" | "light", anything else = the
 *  factory mode (dark). */
export function resolveThemeMode(mode: unknown): ThemeMode {
	return mode === "light" || mode === "dark" ? mode : FACTORY_SETTINGS.appearance.mode;
}

/** Set the dark class for a mode. Other classes are left alone. */
export function applyThemeClass(
	classList: { toggle(token: string, force?: boolean): boolean },
	mode: ThemeMode,
): void {
	classList.toggle(DARK_CLASS, mode === "dark");
}

/** Inline script for <head>: a cached "light" drops the server-rendered
 *  dark class before the first paint. Dark needs no action (the server
 *  renders it). Storage may be denied or throw: the default then stands. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
	THEME_CACHE_KEY,
)})==="light"){document.documentElement.classList.remove(${JSON.stringify(DARK_CLASS)});}}catch(e){}})();`;
