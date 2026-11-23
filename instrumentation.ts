/**
 * Runs once when the Next server starts (the desktop shell keeps that server
 * alive while the app is open): starts the debrief scheduler (REQ-deb-01,
 * REQ-deb-02) and the research loop's scheduler (REQ-rs-01). Node runtime only.
 * Each start is guarded: a failure is logged and never crashes the server.
 * Both schedulers are inert under NODE_ENV=test. Also schedules one semantic-index refresh
 * (REQ-search-07), so nodes that already exist are indexed once the model is downloaded;
 * the refresh is debounced, a no-op when nothing changed, and skipped under NODE_ENV=test.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	if (process.env.NODE_ENV !== "test") {
		const { enforceStartupGuards } = await import("@/src/server/startup-guards");
		enforceStartupGuards();
	}
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
	if (process.env.NODE_ENV !== "test") {
		try {
			const { scheduleSemanticRefresh } = await import("@/src/server/ext/semantic-live");
			scheduleSemanticRefresh();
		} catch {
			console.error("[search] initial index refresh could not be scheduled");
		}
	}
}
