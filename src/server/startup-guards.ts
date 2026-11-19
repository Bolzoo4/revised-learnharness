// src/server/startup-guards.ts
import { PATHS } from "../../config.ts";
import { readAccessSettings } from "./access/config.ts";
import { acquireDataLock } from "./data-lock.ts";

/**
 * Called once from instrumentation.ts. Refuses to serve without an access gate (production
 * with no valid token) or on a data folder another live server owns.
 * @post returns only when the gate is configured (or open outside production) and this
 *       process holds the data lock; otherwise `exit(1)` was called after logging why
 */
export function enforceStartupGuards(exit: (code: number) => never = (code) => process.exit(code)): void {
	const access = readAccessSettings();
	if (access.mode === "enforced" && !access.token) {
		console.error("[access] LH_ACCESS_TOKEN_FILE is missing, unreadable or shorter than 32 characters; refusing to start");
		exit(1);
	}
	try {
		const lock = acquireDataLock(PATHS.data);
		process.on("exit", () => lock.release());
	} catch (error) {
		console.error(`[data] ${error instanceof Error ? error.message : "cannot take the data lock"}; refusing to start`);
		exit(1);
	}
}
