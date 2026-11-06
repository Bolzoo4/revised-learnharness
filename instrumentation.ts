/**
 * Runs once when the Next server starts (the desktop shell keeps that server
 * alive while the app is open): starts the debrief scheduler (REQ-deb-01,
 * REQ-deb-02) and the research loop's scheduler (REQ-rs-01). Node runtime only.
 * Each start is guarded: a failure is logged and never crashes the server.
 * Both schedulers are inert under NODE_ENV=test.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	try {
		const { startDebriefScheduler } = await import("@/src/server");
		startDebriefScheduler();
	} catch {
		console.error("[debrief] scheduler could not start");
	}
	try {
		const { startResearchScheduler } = await import("@/src/server");
		startResearchScheduler();
	} catch {
		console.error("[research] scheduler could not start");
	}
}
