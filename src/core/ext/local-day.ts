// src/core/ext/local-day.ts
/** Local-time day helpers shared by the app's personal layer and the MCP server (REQ-mcp-07). */

/** Local midnight as an ISO instant: "today" for the daily budget and the dialogic cap. */
export function startOfLocalDay(now: Date = new Date()): string {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.toISOString();
}

/** The local calendar date of an instant as YYYY-MM-DD. */
export function localIsoDate(at: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
