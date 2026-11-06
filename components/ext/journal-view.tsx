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

/** The journal's default page size (the server's list default). A longer history is truncated and says so. */
const LIST_LIMIT = 50;
const REQUEST_FAILED = "Request failed.";
const LOAD_FAILED = "The history could not be loaded. Try again.";

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
	const [loadFailed, setLoadFailed] = useState(false);
	const [truncated, setTruncated] = useState(false);
	const [pausedUntil, setPausedUntil] = useState<string | null>(null);

	/** A failed list is an error state, not an empty history. Never throws: the view keeps what it had. */
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/ext/debriefs");
			if (!res.ok) {
				setLoadFailed(true);
				return;
			}
			const json = (await res.json()) as { entries: Entry[]; open: OpenSession[]; truncated?: boolean; providerPausedUntil?: string | null };
			setEntries(json.entries);
			setOpen(json.open);
			setPausedUntil(typeof json.providerPausedUntil === "string" ? json.providerPausedUntil : null);
			setTruncated(json.truncated === true);
			setLoadFailed(false);
		} catch {
			setLoadFailed(true);
		}
	}, []);

	// Opening the journal catches up on sessions that ended while the app was closed and on the due week.
	useEffect(() => {
		void refresh();
		void fetch("/api/ext/debriefs/sweep", { method: "POST" })
			.catch(() => undefined) // a failed catch-up is retried on the next opening or sweep tick
			.finally(() => void refresh());
	}, [refresh]);

	async function end(sessionId: string) {
		setBusy(sessionId);
		setNotice(null);
		try {
			const res = await fetch("/api/ext/debriefs/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
			const json = (await res.json().catch(() => ({}))) as { status?: string; entry?: Entry };
			if (json.entry) setFresh(json.entry);
			else if (json.status === "empty") setNotice("Nothing happened in that session, so there is nothing to comment on.");
			else if (json.status === "deferred") setNotice("The commentary could not be produced now; it will be retried.");
			else setNotice(REQUEST_FAILED); // the server's own message is never shown
		} catch {
			setNotice(REQUEST_FAILED);
		} finally {
			setBusy(null);
			void refresh();
		}
	}

	return (
		<div className="flex flex-col gap-6">
			{pausedUntil !== null ? <p role="status">Debriefs paused: provider usage limit reached, retrying around {new Date(pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p> : null}
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
				{loadFailed ? <p role="alert" className="text-sm text-destructive">{LOAD_FAILED}</p> : null}
				{!loadFailed && entries.length === 0 ? <p className="text-sm text-muted-foreground">No debrief yet.</p> : null}
				{truncated ? <p className="text-sm text-muted-foreground">Showing newest {LIST_LIMIT}.</p> : null}
				{entries.map((e) => (
					<EntryCard key={e.id} entry={e} />
				))}
			</section>
		</div>
	);
}
