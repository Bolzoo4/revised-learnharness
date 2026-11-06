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

/** The mark kinds (src/core/ext/frontier.ts), each with the one phrase that says what it does. */
const MARK_OPTIONS: ReadonlyArray<{ value: Mark["mark"]; label: string }> = [
	{ value: "expand", label: "expand: look for new material here" },
	{ value: "hold", label: "hold: only check what is already known" },
	{ value: "stop", label: "stop: leave this area alone" },
];

/** The stop reasons a cycle log can carry (src/core/ext/research-log.ts), in plain words. */
const STOP_LABELS: Record<string, string> = {
	completed: "finished",
	"no-gaps": "nothing left to research",
	ceiling: "daily budget reached",
	"provider-limit": "provider usage limit reached",
	aborted: "aborted",
	error: "stopped by an error",
};

const WATCH_LABELS: Record<WatchEntry["kind"], string> = {
	"arxiv-query": "arXiv query",
	feed: "feed",
	repo: "repo",
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

/** Which cycle controls are usable now. Abort and steering need a running cycle; a start is refused while one runs. */
export function cycleControls(status: ResearchStatus | null) {
	const running = status?.running === true;
	return {
		startDisabled: running,
		abortDisabled: !running,
		steerDisabled: !running,
		steerHint: running ? null : "Steering works only while a cycle is running.",
	};
}

/** The one-line state of the cycle, in plain words: Loading, Idle, or Running (who started it, since when). */
export function statusText(status: ResearchStatus | null): string {
	if (status === null) return "Loading";
	if (!status.running) return "Idle";
	const who = status.trigger === "schedule" ? "scheduled" : "started by you";
	const since = status.startedAt ? `, since ${new Date(status.startedAt).toLocaleString()}` : "";
	return `Running (${who}${since})`;
}

/** The pause line, or null when no provider pause is in force. */
export function pauseText(status: ResearchStatus | null): string | null {
	if (!status?.providerPausedUntil) return null;
	const until = new Date(status.providerPausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `Paused: provider usage limit until ${until}.`;
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

	const controls = cycleControls(status);

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

	const paused = pauseText(status);
	const lastCycleAt = status?.lastCycle ? new Date(status.lastCycle.endedAt).toLocaleString() : "never";

	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm">
				A research cycle looks for new sources related to your goals and proposes them in the inbox below. It never adds
				anything to your library without your approval. Each cycle uses your model subscription and counts against the
				daily research budget.
			</p>

			{notice !== null && <p role="alert" className="text-sm">{notice}</p>}

			<section className="flex flex-col gap-3 rounded border p-4">
				<h2 className="font-medium">Status</h2>
				<p className="text-sm text-muted-foreground">Whether a cycle is running now, and when the last one ended.</p>
				<p className="text-sm">{statusText(status)}</p>
				{paused !== null && <p className="text-sm" role="status">{paused}</p>}
				<p className="text-sm text-muted-foreground">Last cycle: {lastCycleAt}</p>
				<div className="flex flex-wrap gap-2">
					<button type="button" onClick={startCycle} disabled={controls.startDisabled} className="rounded border border-primary px-3 py-1">
						Run a cycle now
					</button>
					<button type="button" onClick={() => void abortCycle()} disabled={controls.abortDisabled} className="rounded border px-3 py-1">
						Abort
					</button>
					<button type="button" onClick={openChat} className="rounded border px-3 py-1">Open research chat</button>
				</div>
				<p className="text-xs text-muted-foreground">Open research chat: talk to the research agent in a chat session.</p>
				<form onSubmit={sendSteer} className="flex flex-wrap items-end gap-2">
					<label className="flex flex-1 flex-col gap-1 text-sm">
						<span>Steer the running cycle</span>
						<input
							className="rounded border px-2 py-1"
							value={steerText}
							onChange={(e) => setSteerText(e.target.value)}
							disabled={controls.steerDisabled}
						/>
					</label>
					<button type="submit" disabled={controls.steerDisabled} className="rounded border px-3 py-1">Send steer</button>
					{controls.steerHint !== null && <p className="w-full text-xs text-muted-foreground">{controls.steerHint}</p>}
				</form>
				{status !== null && status.steers.length > 0 && (
					<ul className="text-sm">{status.steers.map((s, i) => <li key={i}>{s}</li>)}</ul>
				)}
			</section>

			<section className="flex flex-col gap-3 rounded border p-4">
				<h2 className="font-medium">Inbox (pending)</h2>
				<p className="text-sm text-muted-foreground">
					Sources a cycle found, waiting for your decision. Approve reads one into your graph once. Add to library and read
					keeps it and reads it. Reject drops it.
				</p>
				{inbox.length === 0 && <p className="text-sm text-muted-foreground">Nothing waiting. Run a cycle or add a watch entry.</p>}
				<ul className="flex flex-col gap-3">
					{inbox.map((item) => (
						<li key={item.locator} className="flex flex-col gap-1 text-sm">
							<span>{item.title || item.locator}</span>
							<span className="text-xs text-muted-foreground">{item.locator}</span>
							<div className="flex flex-wrap items-center gap-2">
								<button type="button" onClick={() => void decide(item.locator, "approved")} className="rounded border px-3 py-1">
									Approve (read once)
								</button>
								<label className="flex items-center gap-1">
									<span>Tier</span>
									<select
										value={tiers[item.locator] ?? "secondary"}
										onChange={(e) => setTiers((t) => ({ ...t, [item.locator]: e.target.value as "primary" | "secondary" }))}
										className="rounded border px-1 py-0.5"
									>
										<option value="secondary">secondary</option>
										<option value="primary">primary</option>
									</select>
								</label>
								<button type="button" onClick={() => void decide(item.locator, "activated")} className="rounded border px-3 py-1">
									Add to library and read
								</button>
								<button type="button" onClick={() => void decide(item.locator, "rejected")} className="rounded border px-3 py-1">
									Reject
								</button>
							</div>
						</li>
					))}
				</ul>
				<p className="text-xs text-muted-foreground">Tier: primary sources are used to check what you learn; secondary sources are background reading.</p>
			</section>

			<section className="flex flex-col gap-3 rounded border p-4">
				<h2 className="font-medium">Marks</h2>
				<p className="text-sm text-muted-foreground">
					Tell research where to focus. A node is one item, a subtree is an item and everything under it, and a goal is one of
					your goals.
				</p>
				{marks.length === 0 && <p className="text-sm text-muted-foreground">No marks yet. Add one below to steer where research looks.</p>}
				<ul className="flex flex-col gap-2 text-sm">
					{marks.map((m) => (
						<li key={m.id} className="flex flex-wrap items-center gap-2">
							<span>
								{m.scope.kind} {m.scope.id}: {m.mark}
								{m.budgetUsd !== undefined ? `, budget ${m.budgetUsd} USD` : ""}, set by {m.author === "user" ? "you" : "research"}
							</span>
							<select aria-label="Change mark" value={m.mark} onChange={(e) => void changeMark(m, e.target.value as Mark["mark"])} className="rounded border px-1 py-0.5">
								{MARK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
							</select>
							<button type="button" onClick={() => void removeMark(m.id)} className="rounded border px-3 py-1">Remove</button>
						</li>
					))}
				</ul>
				<form onSubmit={addMark} className="flex flex-wrap items-end gap-2 text-sm">
					<label className="flex flex-col gap-1">
						<span>Mark target kind</span>
						<select value={markForm.scopeKind} onChange={(e) => setMarkForm((f) => ({ ...f, scopeKind: e.target.value }))} className="rounded border px-1 py-0.5">
							<option value="node">node</option>
							<option value="subtree">subtree</option>
							<option value="goal">goal</option>
						</select>
					</label>
					<label className="flex flex-col gap-1">
						<span>Node id / goal id</span>
						<input value={markForm.scopeId} onChange={(e) => setMarkForm((f) => ({ ...f, scopeId: e.target.value }))} className="rounded border px-2 py-1" />
					</label>
					<label className="flex flex-col gap-1">
						<span>Action</span>
						<select value={markForm.mark} onChange={(e) => setMarkForm((f) => ({ ...f, mark: e.target.value }))} className="rounded border px-1 py-0.5">
							{MARK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
						</select>
					</label>
					<button type="submit" className="rounded border px-3 py-1">Add mark</button>
				</form>
			</section>

			<section className="flex flex-col gap-3 rounded border p-4">
				<h2 className="font-medium">Watchlist</h2>
				<p className="text-sm text-muted-foreground">Feeds and arXiv queries that research checks for new items, each on its own schedule.</p>
				{watchlist.length === 0 && <p className="text-sm text-muted-foreground">Nothing is watched yet. Add an arXiv query or a feed below.</p>}
				<ul className="flex flex-col gap-2 text-sm">
					{watchlist.map((w) => (
						<li key={w.id} className="flex flex-wrap items-center gap-2">
							<span>{WATCH_LABELS[w.kind]}: {w.query}, checked every {w.cadenceHours} hours</span>
							<button type="button" onClick={() => void removeWatch(w.id)} className="rounded border px-3 py-1">Remove</button>
						</li>
					))}
				</ul>
				<form onSubmit={addWatch} className="flex flex-wrap items-end gap-2 text-sm">
					<label className="flex flex-col gap-1">
						<span>Watch type</span>
						<select value={watchForm.kind} onChange={(e) => setWatchForm((f) => ({ ...f, kind: e.target.value }))} className="rounded border px-1 py-0.5">
							<option value="arxiv-query">arXiv query</option>
							<option value="feed">feed URL</option>
							<option value="repo">repo (owner/name)</option>
						</select>
					</label>
					<label className="flex flex-1 flex-col gap-1">
						<span>Query or feed URL</span>
						<input value={watchForm.query} onChange={(e) => setWatchForm((f) => ({ ...f, query: e.target.value }))} className="rounded border px-2 py-1" />
					</label>
					<button type="submit" className="rounded border px-3 py-1">Add to watchlist</button>
				</form>
			</section>

			<section className="flex flex-col gap-3 rounded border p-4">
				<h2 className="font-medium">Recent cycles</h2>
				<p className="text-sm text-muted-foreground">The last few cycles: when each ended, why it stopped, how many nodes it added and what it cost.</p>
				{log.length === 0 && <p className="text-sm text-muted-foreground">No cycles yet. Run one now, or wait for the first scheduled cycle.</p>}
				<ul className="flex flex-col gap-1 text-sm">
					{log.map((c) => (
						<li key={c.cycleId}>
							{new Date(c.endedAt).toLocaleString()} ({c.trigger === "schedule" ? "scheduled" : "started by you"}): {STOP_LABELS[c.stoppedBy] ?? "stopped"}, {c.nodesAdded} nodes added, {c.costUsd.toFixed(3)} USD
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
