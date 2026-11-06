/**
 * Runs once when the Next server starts (the desktop shell keeps that server
 * alive while the app is open): starts the debrief scheduler (REQ-deb-01,
 * REQ-deb-02). Node runtime only.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startDebriefScheduler } = await import("@/src/server");
	startDebriefScheduler();
}
