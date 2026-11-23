"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LABEL = "org.revisedlearnharness.app";

/** The launchd label: the default, or the id in <support>/app-id (a per-Mac override kept out of the repository). */
function readServiceLabel(home = os.homedir()) {
	try {
		const value = fs.readFileSync(path.join(home, "Library", "Application Support", "LearnHarness", "app-id"), "utf8").trim();
		return /^[A-Za-z0-9.-]+$/.test(value) ? value : DEFAULT_LABEL;
	} catch {
		return DEFAULT_LABEL;
	}
}

const SERVICE_LABEL = readServiceLabel();

class ServiceUnavailableError extends Error {
	constructor(message) { super(message); this.name = "ServiceUnavailableError"; }
}

/** The port the installed service listens on, read from its own launchd plist. */
async function servicePort({ plistPath, plutil }) {
	let text;
	try { text = await plutil(plistPath); }
	catch { throw new ServiceUnavailableError(`LearnHarness service is not installed (${plistPath}). Run scripts/service/install.sh.`); }
	const port = Number.parseInt(String(text).trim(), 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServiceUnavailableError(`The service plist has no valid port (${plistPath}). Reinstall with scripts/service/install.sh.`);
	return port;
}

/**
 * Make sure the service is running the same version as this app.
 * deps: { healthUrl, appVersion, uid, plistPath, fetchHealth(url) -> {version}|null,
 *         launchctl(args) -> {code}, sleep(ms), timeoutMs?, intervalMs? }
 */
async function ensureService(deps) {
	const { healthUrl, appVersion, uid, plistPath, fetchHealth, launchctl, sleep, timeoutMs = 30000, intervalMs = 300 } = deps;
	const target = `gui/${uid}/${SERVICE_LABEL}`;
	const current = await fetchHealth(healthUrl);
	if (current && current.version === appVersion) return { started: false };

	if (current) {
		// Running, but from another build: restart it onto the installed bundle.
		await launchctl(["kickstart", "-k", target]);
	} else {
		const kicked = await launchctl(["kickstart", target]);
		if (kicked.code !== 0) {
			const booted = await launchctl(["bootstrap", `gui/${uid}`, plistPath]);
			if (booted.code !== 0) throw new ServiceUnavailableError(`LearnHarness service is not installed (${plistPath}). Run scripts/service/install.sh.`);
			await launchctl(["kickstart", target]);
		}
	}

	for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
		const health = await fetchHealth(healthUrl);
		if (health && health.version === appVersion) return { started: true };
		await sleep(intervalMs);
	}
	throw new ServiceUnavailableError("The LearnHarness service did not become ready. See ~/Library/Logs/learnharness-service.log.");
}

/** Unload the service so launchd's KeepAlive cannot restart it while the app bundle is replaced. */
async function stopService({ uid, launchctl }) {
	await launchctl(["bootout", `gui/${uid}/${SERVICE_LABEL}`]);
}

module.exports = { readServiceLabel, DEFAULT_LABEL, ensureService, servicePort, stopService, ServiceUnavailableError, SERVICE_LABEL };
