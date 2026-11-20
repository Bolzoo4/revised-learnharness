import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapacitorConfig } from "@capacitor/cli";

/** Same dark background as the web app, so there is no white flash at launch. */
const NATIVE_BACKGROUND = "#141414";

/**
 * The service address (host:port) is personal, so it is never committed: it comes from
 * LH_SHELL_HOST, else from the file `scripts/service/serve.sh on` writes.
 */
function serviceHost(): string {
	const fromEnv = process.env.LH_SHELL_HOST?.trim();
	if (fromEnv) return fromEnv;
	const file = join(homedir(), "Library", "Application Support", "LearnHarness", "tailnet-host");
	try { const host = readFileSync(file, "utf8").trim(); if (host) return host; } catch { /* handled below */ }
	throw new Error("No service address: run scripts/service/serve.sh on, or set LH_SHELL_HOST=<host>:<port>");
}

/** Only the Mac itself (simulator testing) is reached over plain http; every other host must be https. */
const host = serviceHost();
const loopback = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host);

const config: CapacitorConfig = {
	appId: "org.revisedlearnharness.app",
	appName: "LearnHarness",
	webDir: "www",
	backgroundColor: NATIVE_BACKGROUND,
	server: { url: `${loopback ? "http" : "https"}://${host}`, cleartext: loopback },
	ios: { backgroundColor: NATIVE_BACKGROUND },
};

export default config;
