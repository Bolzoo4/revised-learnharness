// src/server/ext/mcp/app-api.ts
/**
 * The live AppApiPort: the write tools' and get_sandbox's only network use (REQ-graph-agent-16, 22).
 * It signs in to the running app on loopback with the access token (the token
 * file named by LH_ACCESS_TOKEN_FILE), keeps the session cookie, sends it with
 * the Host and Origin the app's gate requires, signs in again once on a 401, and
 * gives each call 30 seconds. The app's own error text reaches the agent verbatim;
 * an app that is not running or not paired gets one fixed sentence.
 */

import fs from "node:fs";
import { ToolError } from "../../../core/ext/mcp/errors.ts";
import { capText } from "../../../core/ext/mcp/limits.ts";
import type { AppApiPort } from "../../../core/ext/mcp/ports.ts";

export const NOT_RUNNING_MESSAGE = "the LearnHarness app is not running or not paired; start it and try again.";
const TIMEOUT_MESSAGE = "the LearnHarness app did not answer in time; try again.";
const DEFAULT_PORT = 47890;
const TIMEOUT_MS = 30_000;
const COOKIE = "lh_session";
const ERROR_TEXT_CHARS = 500;

export interface AppApiOptions {
	/** LH_ACCESS_TOKEN_FILE. Unset or unreadable means the app is not paired. */
	tokenFile: string | undefined;
	/** LH_ACCESS_ALLOWED_HOSTS: its loopback entry gives the port. */
	allowedHosts: string | undefined;
	fetch?: typeof fetch;
	readFile?: (file: string) => string;
	timeoutMs?: number;
}

/** The loopback port: the 127.0.0.1 entry of LH_ACCESS_ALLOWED_HOSTS, else the localhost entry, else 47890. */
export function loopbackPort(allowedHosts: string | undefined): number {
	const entries = (allowedHosts ?? "").split(",").map((h) => h.trim().toLowerCase());
	for (const name of ["127.0.0.1", "localhost"]) {
		for (const entry of entries) {
			if (!entry.startsWith(`${name}:`)) continue;
			const port = Number(entry.slice(name.length + 1));
			if (Number.isInteger(port) && port > 0 && port < 65536) return port;
		}
	}
	return DEFAULT_PORT;
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/** The session value of the lh_session cookie the app set, or null. */
function sessionOf(res: Response): string | null {
	for (const cookie of res.headers.getSetCookie()) {
		const m = new RegExp(`^${COOKIE}=([^;]+)`).exec(cookie);
		if (m) return m[1]!;
	}
	return null;
}

/** The app's error as a tool error: its `error` text when the body is JSON with one, else the body, cut. */
async function rejection(res: Response): Promise<ToolError> {
	const raw = await res.text().catch(() => "");
	let text = raw.trim();
	try {
		const parsed = JSON.parse(raw) as { error?: unknown };
		if (typeof parsed?.error === "string") text = parsed.error;
	} catch {
		// Not JSON: the body text is the message.
	}
	if (text === "") text = `the app answered ${res.status}`;
	return new ToolError("app_rejected", capText(text, ERROR_TEXT_CHARS));
}

export function createAppApi(opts: AppApiOptions): AppApiPort {
	const port = loopbackPort(opts.allowedHosts);
	const host = `127.0.0.1:${port}`;
	const origin = `http://${host}`;
	const doFetch = opts.fetch ?? fetch;
	const readFile = opts.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
	const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
	let session: string | null = null;

	function readToken(): string {
		if (!opts.tokenFile) throw new ToolError("app_unreachable", NOT_RUNNING_MESSAGE);
		try {
			const token = readFile(opts.tokenFile).trim();
			if (token === "") throw new Error("empty token");
			return token;
		} catch {
			throw new ToolError("app_unreachable", NOT_RUNNING_MESSAGE);
		}
	}

	async function send(method: string, path: string, body: unknown, cookie: string | null): Promise<Response> {
		const headers: Record<string, string> = { Host: host, Origin: origin, "Content-Type": "application/json" };
		if (cookie !== null) headers.Cookie = `${COOKIE}=${cookie}`;
		try {
			return await doFetch(`${origin}${path}`, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
		} catch (error) {
			throw new ToolError("app_unreachable", isTimeout(error) ? TIMEOUT_MESSAGE : NOT_RUNNING_MESSAGE);
		}
	}

	async function signIn(): Promise<void> {
		const token = readToken();
		const res = await send("POST", "/api/access/signin", { token }, null);
		if (!res.ok) throw await rejection(res);
		const value = sessionOf(res);
		if (value === null) throw new ToolError("app_rejected", "the app did not start a session; check the access token.");
		session = value;
	}

	async function request(method: string, path: string, body: unknown): Promise<unknown> {
		if (session === null) await signIn();
		let res = await send(method, path, body, session);
		if (res.status === 401) {
			await signIn();
			res = await send(method, path, body, session);
		}
		if (!res.ok) throw await rejection(res);
		try {
			return await res.json();
		} catch {
			throw new ToolError("app_rejected", "the app answered without a JSON body.");
		}
	}

	return {
		post: (path, body) => request("POST", path, body),
		put: (path, body) => request("PUT", path, body),
		get: (path) => request("GET", path, undefined),
	};
}
