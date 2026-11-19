/** Shared provenance only: no credential-store reads in the agent layer. */
interface AuthBoot {
	/** Names owned by the original launch environment. */
	realEnv: Set<string>;
	/** Names reflected into process.env by LearnHarness's key store. */
	fillGap: Set<string>;
}
const BOOT_KEY = Symbol.for("lh.authBoot");

export function authEnvRecord(): AuthBoot {
	const g = globalThis as Record<symbol, AuthBoot | undefined>;
	if (!g[BOOT_KEY]) g[BOOT_KEY] = { realEnv: new Set(), fillGap: new Set() };
	return g[BOOT_KEY];
}

/** The access gate's settings belong to the server only; no child process inherits them. */
export function withoutAccessEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const result: Record<string, string | undefined> = { ...env };
	for (const name of Object.keys(result)) if (name.startsWith("LH_ACCESS_")) delete result[name];
	return result as NodeJS.ProcessEnv;
}

/** External CLIs own their authentication. Never pass LearnHarness-only injections. */
export function externalCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result = withoutAccessEnv(env);
	const { realEnv, fillGap } = authEnvRecord();
	for (const name of fillGap) {
		if (!realEnv.has(name)) delete result[name];
	}
	return result;
}
