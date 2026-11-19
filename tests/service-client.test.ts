// tests/service-client.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ensureService, servicePort, stopService, ServiceUnavailableError, SERVICE_LABEL } = require("../electron/service-client.cjs");

const target = `gui/501/${SERVICE_LABEL}`;
function harness(opts: { health: Array<{ version: string } | null>; launchctl?: (args: string[]) => { code: number } }) {
	const calls: string[][] = [];
	let i = 0;
	return {
		calls,
		deps: {
			healthUrl: "http://127.0.0.1:1/healthz", appVersion: "1.2.3", uid: 501, plistPath: "/p.plist",
			timeoutMs: 1000, intervalMs: 100,
			fetchHealth: async () => opts.health[Math.min(i++, opts.health.length - 1)],
			launchctl: async (args: string[]) => { calls.push(args); return opts.launchctl?.(args) ?? { code: 0 }; },
			sleep: async () => {},
		},
	};
}

test("a running service with the same version is left alone", async () => {
	const h = harness({ health: [{ version: "1.2.3" }] });
	assert.deepEqual(await ensureService(h.deps), { started: false });
	assert.deepEqual(h.calls, []);
});

test("a running service with a different version is restarted with kickstart -k and awaited", async () => {
	const h = harness({ health: [{ version: "1.0.0" }, { version: "1.0.0" }, { version: "1.2.3" }] });
	assert.deepEqual(await ensureService(h.deps), { started: true });
	assert.deepEqual(h.calls, [["kickstart", "-k", target]]);
});

test("a stopped but loaded service is kickstarted", async () => {
	const h = harness({ health: [null, null, { version: "1.2.3" }] });
	assert.deepEqual(await ensureService(h.deps), { started: true });
	assert.deepEqual(h.calls, [["kickstart", target]]);
});

test("an unloaded service is bootstrapped from the plist, then kickstarted", async () => {
	let kicks = 0;
	const h = harness({
		health: [null, { version: "1.2.3" }],
		launchctl: (args) => (args[0] === "kickstart" && kicks++ === 0 ? { code: 113 } : { code: 0 }),
	});
	assert.deepEqual(await ensureService(h.deps), { started: true });
	assert.deepEqual(h.calls, [["kickstart", target], ["bootstrap", "gui/501", "/p.plist"], ["kickstart", target]]);
});

test("a service that cannot be bootstrapped reports it is not installed", async () => {
	const h = harness({ health: [null], launchctl: () => ({ code: 5 }) });
	await assert.rejects(ensureService(h.deps), (error: Error) => error instanceof ServiceUnavailableError && /not installed/.test(error.message) && error.message.includes("/p.plist"));
});

test("a service that never answers fails after the timeout", async () => {
	const h = harness({ health: [null] });
	await assert.rejects(ensureService(h.deps), (error: Error) => error instanceof ServiceUnavailableError && /did not become ready/.test(error.message));
});

test("a service that answers with the wrong version forever also fails", async () => {
	const h = harness({ health: [{ version: "0.0.1" }] });
	await assert.rejects(ensureService(h.deps), ServiceUnavailableError);
});

test("servicePort reads the PORT from the plist", async () => {
	assert.equal(await servicePort({ plistPath: "/p", plutil: async () => "47890\n" }), 47890);
});

test("servicePort rejects an unreadable plist and invalid ports", async () => {
	for (const plutil of [async () => { throw new Error("no file"); }, async () => "abc", async () => "0", async () => "70000", async () => ""]) {
		await assert.rejects(servicePort({ plistPath: "/p", plutil }), ServiceUnavailableError);
	}
});

test("stopService boots the service out of launchd", async () => {
	const calls: string[][] = [];
	await stopService({ uid: 501, launchctl: async (a: string[]) => { calls.push(a); return { code: 0 }; } });
	assert.deepEqual(calls, [["bootout", target]]);
});
