"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

/*
 * The research page (functional, not styled: the UI redesign session comes later).
 * Components import only the core barrel, so these shapes are local mirrors of the
 * route responses (app/api/ext/research/*). Every failure shows one fixed text;
 * the server's messages are never displayed.
 */

type Trigger = "schedule" | "manual";
interface CycleLogEntry {
	cycleId: string;
	trigger: Trigger;
	endedAt: string;
	stoppedBy: string;
	nodesAdded: number;
	costUsd: number;
}
interface ResearchStatus {
	running: boolean;
	trigger?: Trigger;
	startedAt?: string;
	steers: string[];
	lastCycle: CycleLogEntry | null;
	/** ISO end of a provider usage-limit pause, while one is in force. */
	providerPausedUntil?: string | null;
}
interface Mark {
	id: string;
	scope: { kind: "node" | "subtree" | "goal"; id: string };
	mark: "expand" | "hold" | "stop";
	budgetUsd?: number;
	author: "user" | "agent";
}
interface InboxItem {
	locator: string;
	title: string;
	gapId: string;
	foundBy: string;
	status: string;
}
interface WatchEntry {
	id: string;
	kind: "arxiv-query" | "feed" | "repo";
	query: string;
	cadenceHours: number;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";
const START_REFUSALS: Record<string, string> = {
	"already-running": "A cycle is already running.",
	"not-configured": "No research model is configured.",
	"clock-invalid": GENERIC_ERROR,
};

/** One request; a non-2xx answer or a network failure both give null (the caller shows GENERIC_ERROR). */
async function call<T>(method: string, url: string, body?: unknown): Promise<T | null> {
	try {
		const res = await fetch(url, {
			method,
			headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

export function ResearchView() {
	const [status, setStatus] = useState<ResearchStatus | null>(null);
	const [log, setLog] = useState<CycleLogEntry[]>([]);
	const [marks, setMarks] = useState<Mark[]>([]);
	const [inbox, setInbox] = useState<InboxItem[]>([]);
	const [watchlist, setWatchlist] = useState<WatchEntry[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [steerText, setSteerText] = useState("");
	const [markForm, setMarkForm] = useState({ scopeKind: "node", scopeId: "", mark: "expand" });
	const [watchForm, setWatchForm] = useState({ kind: "arxiv-query", query: "" });
	const [tiers, setTiers] = useState<Record<string, "primary" | "secondary">>({});

	const refresh = useCallback(async () => {
		const [s, l, m, i, w] = await Promise.all([
			call<ResearchStatus>("GET", "/api/ext/research/cycle"),
			call<{ log: CycleLogEntry[] }>("GET", "/api/ext/research/log?limit=5"),
			call<{ marks: Mark[] }>("GET", "/api/ext/research/marks"),
			call<{ items: InboxItem[] }>("GET", "/api/ext/research/inbox?status=pending"),
			call<{ entries: WatchEntry[] }>("GET", "/api/ext/research/watchlist"),
		]);
		if (s) setStatus(s);
		if (l) setLog(l.log);
		if (m) setMarks(m.marks);
		if (i) setInbox(i.items);
		if (w) setWatchlist(w.entries);
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 15_000);
		return () => clearInterval(timer);
	}, [refresh]);

	/** Runs one action, reports a fixed failure text, then reloads everything. */
	async function act(work: () => Promise<boolean>, failure = GENERIC_ERROR) {
		setNotice(null);
		const ok = await work();
		if (!ok) setNotice(failure);
		await refresh();
	}

	const startCycle = () =>
		act(async () => {
			const res = await call<{ started: boolean; reason?: string }>("POST", "/api/ext/research/cycle", { action: "start" });
			if (res === null) return false;
			if (!res.started) setNotice(START_REFUSALS[res.reason ?? ""] ?? GENERIC_ERROR);
			return true;
		});

	const abortCycle = () =>
		act(async () => (await call<{ aborted: boolean }>("POST", "/api/ext/research/cycle", { action: "abort" })) !== null);

	const sendSteer = (e: FormEvent) => {
		e.preventDefault();
		const message = steerText.trim();
		if (message === "") return;
		void act(async () => {
			const res = await fetch("/api/ext/research/cycle", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "steer", message }),
			}).catch(() => null);
			if (res === null || (!res.ok && res.status !== 409)) return false;
			if (res.status === 409) setNotice("No cycle is running, so the message was not delivered.");
			else setSteerText("");
			return true;
		});
	};

	const decide = (locator: string, decision: "approved" | "rejected" | "activated") =>
		act(async () => {
			const tier = tiers[locator] ?? "secondary";
			return (await call("POST", "/api/ext/research/inbox", { locator, decision, tier })) !== null;
		});

	const addMark = (e: FormEvent) => {
		e.preventDefault();
		if (markForm.scopeId.trim() === "") return;
		void act(async () => {
			const res = await call("POST", "/api/ext/research/marks", {
				scope: { kind: markForm.scopeKind, id: markForm.scopeId.trim() },
				mark: markForm.mark,
			});
			if (res !== null) setMarkForm((f) => ({ ...f, scopeId: "" }));
			return res !== null;
		});
	};

	/** Editing a mark replaces it: the new mark is written first, then the old one is cleared only if that succeeded. */
	const changeMark = (old: Mark, mark: Mark["mark"]) =>
		act(async () => {
			const created = await call("POST", "/api/ext/research/marks", { scope: old.scope, mark });
			if (created === null) return false;
			return (await call("DELETE", "/api/ext/research/marks", { id: old.id })) !== null;
		});

	const removeMark = (id: string) => act(async () => (await call("DELETE", "/api/ext/research/marks", { id })) !== null);

	const addWatch = (e: FormEvent) => {
		e.preventDefault();
		if (watchForm.query.trim() === "") return;
		void act(async () => {
			const res = await call("POST", "/api/ext/research/watchlist", { kind: watchForm.kind, query: watchForm.query.trim() });
			if (res !== null) setWatchForm((f) => ({ ...f, query: "" }));
			return res !== null;
		});
	};

	const removeWatch = (id: string) => act(async () => (await call("DELETE", "/api/ext/research/watchlist", { id })) !== null);

	const openChat = async () => {
		const res = await call<{ chatId: string }>("POST", "/api/ext/research/session");
		if (res === null) setNotice(GENERIC_ERROR);
		else window.location.href = `/chat/${encodeURIComponent(res.chatId)}`;
	};

	return (
		<div className="flex flex-col gap-6">
			{notice !== null && <p role="alert" className="text-sm">{notice}</p>}

			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Status</h2>
				<p className="text-sm">{status === null ? "Loading" : status.running ? `Running (${status.trigger ?? "manual"}, started ${status.startedAt ?? "now"})` : "Idle"}</p>
				{status?.providerPausedUntil ? <p className="text-sm" role="status">Paused: the AI provider's usage limit is reached, retrying around {new Date(status.providerPausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p> : null}
				{status?.lastCycle && (
					<p className="text-sm text-muted-foreground">
						Last cycle ended {new Date(status.lastCycle.endedAt).toLocaleString()}: {status.lastCycle.stoppedBy}, {status.lastCycle.nodesAdded} nodes added.
					</p>
				)}
				<div className="flex gap-2">
					<button type="button" onClick={startCycle} disabled={status?.running === true}>Run a cycle now</button>
					<button type="button" onClick={() => void abortCycle()} disabled={status?.running !== true}>Abort</button>
					<button type="button" onClick={openChat}>Open research chat</button>
				</div>
				<form onSubmit={sendSteer} className="flex gap-2">
					<input
						aria-label="Steering message"
						className="flex-1"
						value={steerText}
						onChange={(e) => setSteerText(e.target.value)}
						placeholder="Steer the running cycle"
					/>
					<button type="submit">Send steer</button>
				</form>
				{status !== null && status.steers.length > 0 && (
					<ul className="text-sm">{status.steers.map((s, i) => <li key={i}>{s}</li>)}</ul>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Inbox (pending)</h2>
				{inbox.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting for a decision.</p>}
				<ul className="flex flex-col gap-3">
					{inbox.map((item) => (
						<li key={item.locator} className="flex flex-col gap-1 text-sm">
							<span>{item.title || item.locator}</span>
							<span className="text-xs text-muted-foreground">{item.locator}</span>
							<div className="flex flex-wrap gap-2">
								<button type="button" onClick={() => void decide(item.locator, "approved")}>Approve (read once)</button>
								<label>
									Tier{" "}
									<select value={tiers[item.locator] ?? "secondary"} onChange={(e) => setTiers((t) => ({ ...t, [item.locator]: e.target.value as "primary" | "secondary" }))}>
										<option value="secondary">secondary</option>
										<option value="primary">primary</option>
									</select>
								</label>
								<button type="button" onClick={() => void decide(item.locator, "activated")}>Add to library and read</button>
								<button type="button" onClick={() => void decide(item.locator, "rejected")}>Reject</button>
							</div>
						</li>
					))}
				</ul>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Marks</h2>
				{marks.length === 0 && <p className="text-sm text-muted-foreground">No marks.</p>}
				<ul className="flex flex-col gap-2 text-sm">
					{marks.map((m) => (
						<li key={m.id} className="flex flex-wrap items-center gap-2">
							<span>{m.scope.kind} {m.scope.id}: {m.mark}{m.budgetUsd !== undefined ? ` (budget ${m.budgetUsd} USD)` : ""} by {m.author}</span>
							<select aria-label="Change mark" value={m.mark} onChange={(e) => void changeMark(m, e.target.value as Mark["mark"])}>
								<option value="expand">expand</option>
								<option value="hold">hold</option>
								<option value="stop">stop</option>
							</select>
							<button type="button" onClick={() => void removeMark(m.id)}>Remove</button>
						</li>
					))}
				</ul>
				<form onSubmit={addMark} className="flex flex-wrap gap-2 text-sm">
					<select aria-label="Scope kind" value={markForm.scopeKind} onChange={(e) => setMarkForm((f) => ({ ...f, scopeKind: e.target.value }))}>
						<option value="node">node</option>
						<option value="subtree">subtree</option>
						<option value="goal">goal</option>
					</select>
					<input aria-label="Scope id" value={markForm.scopeId} onChange={(e) => setMarkForm((f) => ({ ...f, scopeId: e.target.value }))} placeholder="id" />
					<select aria-label="Mark" value={markForm.mark} onChange={(e) => setMarkForm((f) => ({ ...f, mark: e.target.value }))}>
						<option value="expand">expand</option>
						<option value="hold">hold</option>
						<option value="stop">stop</option>
					</select>
					<button type="submit">Add mark</button>
				</form>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Watchlist</h2>
				{watchlist.length === 0 && <p className="text-sm text-muted-foreground">No watch entries.</p>}
				<ul className="flex flex-col gap-2 text-sm">
					{watchlist.map((w) => (
						<li key={w.id} className="flex items-center gap-2">
							<span>{w.kind}: {w.query} (every {w.cadenceHours} h)</span>
							<button type="button" onClick={() => void removeWatch(w.id)}>Remove</button>
						</li>
					))}
				</ul>
				<form onSubmit={addWatch} className="flex flex-wrap gap-2 text-sm">
					<select aria-label="Watch kind" value={watchForm.kind} onChange={(e) => setWatchForm((f) => ({ ...f, kind: e.target.value }))}>
						<option value="arxiv-query">arXiv query</option>
						<option value="feed">feed URL</option>
						<option value="repo">repo (owner/name)</option>
					</select>
					<input aria-label="Watch query" value={watchForm.query} onChange={(e) => setWatchForm((f) => ({ ...f, query: e.target.value }))} placeholder="query" />
					<button type="submit">Add to watchlist</button>
				</form>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-medium">Recent cycles</h2>
				{log.length === 0 && <p className="text-sm text-muted-foreground">No cycles yet.</p>}
				<ul className="flex flex-col gap-1 text-sm">
					{log.map((c) => (
						<li key={c.cycleId}>
							{new Date(c.endedAt).toLocaleString()} ({c.trigger}): {c.stoppedBy}, {c.nodesAdded} nodes, {c.costUsd.toFixed(3)} USD
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
