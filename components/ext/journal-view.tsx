"use client";

import { useCallback, useEffect, useState } from "react";

interface Entry {
	id: string;
	kind: "session" | "weekly";
	sessionKind: string | null;
	weekOf: string | null;
	at: string;
	facts: Record<string, unknown>;
	commentary: string | null;
	nullReason: "ceiling" | "error" | null;
}
interface OpenSession { sessionId: string; kind: string; title: string; lastActivityAt: string }

const NO_COMMENTARY: Record<string, string> = {
	ceiling: "No commentary: the daily cost ceiling was reached. The facts are below.",
	error: "No commentary: it could not be produced. The facts are below.",
};

function EntryCard({ entry, highlight }: { entry: Entry; highlight?: boolean }) {
	return (
		<article className={`flex flex-col gap-2 rounded border p-3 ${highlight ? "border-primary" : ""}`}>
			<h3 className="font-medium">
				{entry.kind === "weekly" ? `Week of ${entry.weekOf}` : `${entry.sessionKind?.replace("_", " ")} session`}
				<span className="ml-2 text-xs text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
			</h3>
			{entry.commentary !== null ? (
				<div className="whitespace-pre-wrap text-sm">{entry.commentary}</div>
			) : (
				<p className="text-sm text-muted-foreground">{NO_COMMENTARY[entry.nullReason ?? "error"]}</p>
			)}
			<details>
				<summary className="cursor-pointer text-sm">Facts</summary>
				<pre className="overflow-x-auto text-xs">{JSON.stringify(entry.facts, null, 1)}</pre>
			</details>
		</article>
	);
}

/** The journal: running sessions with an "End and debrief" button, and the history of debriefs and weekly syntheses (REQ-deb-08). */
export function JournalView() {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [open, setOpen] = useState<OpenSession[]>([]);
	const [fresh, setFresh] = useState<Entry | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const res = await fetch("/api/ext/debriefs");
		if (!res.ok) return;
		const json = (await res.json()) as { entries: Entry[]; open: OpenSession[] };
		setEntries(json.entries);
		setOpen(json.open);
	}, []);

	// Opening the journal catches up on sessions that ended while the app was closed and on the due week.
	useEffect(() => {
		void refresh();
		void fetch("/api/ext/debriefs/sweep", { method: "POST" }).finally(() => void refresh());
	}, [refresh]);

	async function end(sessionId: string) {
		setBusy(sessionId);
		setNotice(null);
		const res = await fetch("/api/ext/debriefs/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
		const json = (await res.json().catch(() => ({}))) as { status?: string; entry?: Entry; error?: string };
		if (json.entry) setFresh(json.entry);
		else if (json.status === "empty") setNotice("Nothing happened in that session, so there is nothing to comment on.");
		else if (json.status === "deferred") setNotice("The commentary could not be produced now; it will be retried.");
		else setNotice(json.error ?? "Request failed.");
		setBusy(null);
		void refresh();
	}

	return (
		<div className="flex flex-col gap-6">
			{notice !== null ? <p role="status">{notice}</p> : null}
			{fresh !== null ? <EntryCard entry={fresh} highlight /> : null}
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Running sessions</h2>
				{open.length === 0 ? <p className="text-sm text-muted-foreground">No session is running.</p> : null}
				{open.map((s) => (
					<div key={s.sessionId} className="flex items-center justify-between gap-2 rounded border p-2">
						<span className="text-sm">{s.title} <span className="text-muted-foreground">({s.kind.replace("_", " ")})</span></span>
						<button type="button" className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => void end(s.sessionId)}>{busy === s.sessionId ? "Working…" : "End and debrief"}</button>
					</div>
				))}
			</section>
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">History</h2>
				{entries.length === 0 ? <p className="text-sm text-muted-foreground">No debrief yet.</p> : null}
				{entries.map((e) => (
					<EntryCard key={e.id} entry={e} />
				))}
			</section>
		</div>
	);
}
