/**
 * Attached files are copied into the agent's own workspace before they are referenced (the app keeps its own
 * copy, and the file tools only see the workspace by default). A failed call hands the original paths back, so
 * an attachment is never lost to a network error; folders stay as they are (only single files are copied).
 */
export async function importPaths(paths: string[]): Promise<{ paths: string[]; errors: string[] }> {
	try {
		const res = await fetch("/api/ext/workspace/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) });
		if (!res.ok) return { paths, errors: [] };
		const body = (await res.json()) as { paths?: unknown; errors?: unknown };
		const kept = Array.isArray(body.paths) && body.paths.length === paths.length && body.paths.every((p) => typeof p === "string") ? (body.paths as string[]) : paths;
		const errors = Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === "string") : [];
		return { paths: kept, errors };
	} catch {
		return { paths, errors: [] };
	}
}
