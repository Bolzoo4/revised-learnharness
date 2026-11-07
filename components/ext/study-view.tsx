"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { FileText, Maximize2, MessageSquare, PanelRightClose, PenLine, Target, TextSelect, CheckCheck, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { encodeStudyContext } from "@/src/core";
import { Chat } from "@/components/chat";
import { pageFromPoint } from "./citation-click";
import { openNodePanel } from "./open-node";
import { PdfViewer } from "./pdf-viewer";
import {
	clampRatio,
	DEFAULT_LAYOUT,
	DEFAULT_SPLIT_RATIO,
	draftsOf,
	pageFromInput,
	postJson,
	ratioFromPointer,
	readLayoutPrefs,
	REQUEST_FAILED,
	splitBounds,
	splitStep,
	stepZoom,
	writeLayoutPrefs,
	type DraftRowLike,
	type LayoutPrefs,
	type VisiblePages,
} from "./study-logic";

type ChatProps = Pick<
	ComponentProps<typeof Chat>,
	"chatId" | "title" | "initialMessages" | "initialError" | "initialConfigured" | "initiallyInFlight" | "initiallyCompacting"
>;
/** How the conversation is drawn. The page passes the real chat; a test can pass a stand-in. */
export type StudyChatRenderer = (props: ChatProps & { transformOutgoing: (text: string) => string }) => ReactNode;
const renderRealChat: StudyChatRenderer = (p) => <Chat key={p.chatId} {...p} kind="teach" />;

interface CardForm {
	page: number;
	proposition: string;
	question: string;
	answer: string;
}
type DraftRow = DraftRowLike;
interface Message {
	text: string;
	error: boolean;
}
/** The learner's selected text and the page it is on (null when the selection is outside the pages). */
interface Selected {
	text: string;
	page: number | null;
}
const NO_SELECTION: Selected = { text: "", page: null };
/** A page change is saved once the learner has stayed on it this long (the reading rule needs a dwell anyway). */
const READ_DEBOUNCE_MS = 600;

/** Every request goes through here: it never rejects, and a server error is shown as REQUEST_FAILED, never as the server's text. */
const post = (url: string, body: unknown) => postJson((u, init) => fetch(u, init), url, body);

function sameVisible(a: VisiblePages, b: VisiblePages): boolean {
	return a.primary === b.primary && a.others.length === b.others.length && a.others.every((p, i) => p === b.others[i]);
}

/**
 * The study session (REQ-study-04): the document as one scrollable column on the
 * left, the document's one conversation on the right. The page on screen is the
 * page with the largest visible share; the pages partly on screen are named to
 * the tutor with it (REQ-study-06). `(p. N)` in the conversation scrolls the
 * viewer (REQ-study-07). The actions sit in a rail on the edge of the reading
 * area; the divider and the chat's open state are kept per browser.
 */
export function StudyView({
	document: doc,
	startPage,
	chat,
	renderChat = renderRealChat,
}: {
	document: { id: string; title: string; pageCount: number };
	startPage: number;
	chat: ChatProps;
	renderChat?: StudyChatRenderer;
}) {
	const [jump, setJump] = useState({ page: startPage, nonce: 0 });
	const [visible, setVisible] = useState<VisiblePages>({ primary: startPage, others: [] });
	const [zoom, setZoom] = useState(1);
	const [selection, setSelection] = useState<Selected>(NO_SELECTION);
	const [form, setForm] = useState<CardForm | null>(null);
	const [pin, setPin] = useState(true);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<Message | null>(null);
	const [drafts, setDrafts] = useState<DraftRow[]>([]);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [goal, setGoal] = useState({ title: "", statement: "" });
	const [goalBusy, setGoalBusy] = useState(false);
	const goalInFlight = useRef(false);
	const [pageText, setPageText] = useState(String(startPage));
	const [panelOpen, setPanelOpen] = useState(false);
	const [prefs, setPrefs] = useState<LayoutPrefs>(DEFAULT_LAYOUT);
	const [splitWidth, setSplitWidth] = useState(0);
	const splitRef = useRef<HTMLDivElement>(null);
	const chatColumn = useRef<HTMLElement>(null);
	const dragging = useRef(false);
	const draftRatio = useRef<number | null>(null);
	const prefsRef = useRef(prefs);
	prefsRef.current = prefs;

	const page = visible.primary ?? startPage;
	const pageRef = useRef(page);
	const visibleRef = useRef(visible);
	const selectionRef = useRef(selection);
	pageRef.current = page;
	selectionRef.current = selection;

	// Reading events (REQ-study-03): the primary page is saved after a short stay on it; a close when the window is hidden or closed.
	const report = useCallback((body: Record<string, unknown>, keepalive = false) => {
		void fetch("/api/ext/study/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id, ...body }), keepalive }).catch(() => undefined);
	}, [doc.id]);
	useEffect(() => {
		const t = setTimeout(() => report({ kind: "visit", page }), READ_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [page, report]);
	useEffect(() => {
		const onVisibility = () => (document.visibilityState === "hidden" ? report({ kind: "close" }, true) : report({ kind: "visit", page: pageRef.current }));
		const onHide = () => report({ kind: "close" }, true);
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", onHide);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onHide);
			report({ kind: "close" }, true);
		};
	}, [report]);

	// The selection is sticky: clicking into the composer collapses the browser's selection, but the chip keeps it until sent or cleared.
	useEffect(() => {
		const onSelect = () => {
			const sel = window.getSelection();
			const text = sel?.toString().trim() ?? "";
			const inField = sel?.anchorNode instanceof Node && (sel.anchorNode.parentElement?.closest("textarea,input,[contenteditable='true']") ?? null) !== null;
			if (text === "" || inField) return;
			const node = sel?.anchorNode ?? null;
			const el = node instanceof Element ? node : (node?.parentElement ?? null);
			const n = Number(el?.closest("[data-page-number]")?.getAttribute("data-page-number"));
			setSelection({ text, page: Number.isInteger(n) && n >= 1 ? n : null });
		};
		document.addEventListener("selectionchange", onSelect);
		return () => document.removeEventListener("selectionchange", onSelect);
	}, []);

	// A click on "(p. N)" in the conversation scrolls the viewer.
	useEffect(() => {
		const el = chatColumn.current;
		if (!el) return;
		const onClick = (e: MouseEvent) => {
			const cited = pageFromPoint(document, e.clientX, e.clientY);
			if (cited !== null && cited <= doc.pageCount) setJump((j) => ({ page: cited, nonce: j.nonce + 1 }));
		};
		el.addEventListener("click", onClick);
		return () => el.removeEventListener("click", onClick);
	}, [doc.pageCount]);

	// The divider's width: measured, so the ratio can be clamped to two minimum panes.
	useEffect(() => {
		const el = splitRef.current;
		if (!el) return;
		const update = () => setSplitWidth(el.clientWidth);
		update();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// The layout the learner left on this browser; unreadable storage means the defaults.
	useEffect(() => {
		setPrefs(readLayoutPrefs(() => window.localStorage));
	}, []);
	function persist(next: LayoutPrefs) {
		writeLayoutPrefs(() => window.localStorage, next);
	}

	const onVisible = useCallback((v: VisiblePages) => {
		visibleRef.current = v;
		setVisible((prev) => (sameVisible(prev, v) ? prev : v));
	}, []);

	const transformOutgoing = useCallback(
		(text: string) => {
			const v = visibleRef.current;
			const out = encodeStudyContext({ documentId: doc.id, page: v.primary ?? pageRef.current, selection: selectionRef.current.text, pages: v.others }, text);
			setSelection(NO_SELECTION);
			return out;
		},
		[doc.id],
	);

	const go = useCallback(
		(p: number) => setJump((j) => ({ page: Math.min(Math.max(1, p), doc.pageCount), nonce: j.nonce + 1 })),
		[doc.pageCount],
	);
	const say = (text: string) => setMessage({ text, error: false });
	// Stable identity: PdfViewer keeps onError in a ref, but the study view passes it on to other effects too.
	const showError = useCallback((text: string) => setMessage({ text, error: true }), []);

	// The page box mirrors the page on screen; typing is local until Enter or blur commits it.
	useEffect(() => {
		setPageText(String(page));
	}, [page]);
	function commitPage() {
		const target = pageFromInput(pageText, doc.pageCount);
		if (target === null) return setPageText(String(page));
		go(target);
		setPageText(String(target));
	}

	/** The page a card is made from: the selection's page when there is a selection, else the page on screen. */
	function cardPage(): number {
		return selection.text !== "" && selection.page !== null ? selection.page : page;
	}

	async function draftCard(from: "selection" | "page") {
		setBusy(true);
		setMessage(null);
		const useSelection = from === "selection" && selection.text !== "";
		const r = await post("/api/ext/study/cards", { action: "draft", documentId: doc.id, page: cardPage(), ...(useSelection ? { selection: selection.text } : {}) });
		setBusy(false);
		if (!r.ok) return showError(REQUEST_FAILED);
		setPanelOpen(true);
		setForm({ page: cardPage(), proposition: String(r.json.proposition ?? ""), question: String(r.json.question ?? ""), answer: String(r.json.answer ?? "") });
	}
	async function confirmCard() {
		if (form === null) return;
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "confirm", documentId: doc.id, ...form, pin });
		setBusy(false);
		if (!r.ok) return showError(REQUEST_FAILED);
		setForm(null);
		say("Card added.");
		if (typeof r.json.nodeId === "string") openNodePanel(r.json.nodeId);
	}
	async function loadDrafts() {
		try {
			const res = await fetch(`/api/ext/study/drafts?documentId=${encodeURIComponent(doc.id)}`);
			if (!res.ok) showError(REQUEST_FAILED);
			else setDrafts(draftsOf((await res.json().catch(() => ({}))) as Record<string, unknown>));
		} catch {
			showError(REQUEST_FAILED);
		}
		setChosen(new Set());
	}
	useEffect(() => void loadDrafts(), []);
	async function complete() {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/drafts", { action: "complete", documentId: doc.id });
		setBusy(false);
		if (!r.ok) return showError(REQUEST_FAILED);
		setPanelOpen(true);
		say(`${String(r.json.proposed)} draft(s) proposed from ${Array.isArray(r.json.pages) ? r.json.pages.length : 0} page(s).${r.json.ceilingReached === true ? " The daily cost ceiling was reached: run it again tomorrow for the rest." : ""}${r.json.providerLimited === true ? " The AI provider's usage limit is reached: run it again later for the rest." : ""}`);
		await loadDrafts();
	}
	async function decide(kind: "approve" | "reject") {
		const ids = [...chosen];
		if (ids.length === 0) return;
		setBusy(true);
		const r = await post("/api/ext/study/drafts", { action: "decide", ...(kind === "approve" ? { approve: ids.map((draftId) => ({ draftId, pin })) } : { reject: ids }) });
		setBusy(false);
		if (!r.ok) showError(REQUEST_FAILED);
		else {
			const failed = Array.isArray(r.json.failed) ? r.json.failed.length : 0;
			const done = Array.isArray(r.json.approved) && kind === "approve" ? r.json.approved.length : Array.isArray(r.json.rejected) && kind === "reject" ? r.json.rejected.length : 0;
			say(`${done} done${failed > 0 ? `, ${failed} failed` : ""}.`);
		}
		await loadDrafts();
	}
	async function startGoal() {
		if (goalInFlight.current) return; // a second click while the first request runs must not create a second goal
		goalInFlight.current = true;
		setGoalBusy(true);
		try {
			const r = await post("/api/ext/study/goal", { documentId: doc.id, ...goal });
			if (r.ok) {
				say("Goal created.");
				setGoal({ title: "", statement: "" });
			} else showError(REQUEST_FAILED);
		} finally {
			goalInFlight.current = false;
			setGoalBusy(false);
		}
	}

	// ─── the split ───────────────────────────────────────────────────────────
	const ratio = clampRatio(prefs.ratio, splitWidth);
	const bounds = splitBounds(splitWidth);
	function setChatOpen(open: boolean) {
		const next = { ...prefsRef.current, chatOpen: open };
		setPrefs(next);
		persist(next);
	}
	function onDividerDown(e: ReactPointerEvent<HTMLDivElement>) {
		if (e.button !== 0) return;
		dragging.current = true;
		draftRatio.current = null;
		e.currentTarget.setPointerCapture(e.pointerId);
	}
	function onDividerMove(e: ReactPointerEvent<HTMLDivElement>) {
		const el = splitRef.current;
		if (!dragging.current || !el) return;
		const r = ratioFromPointer(e.clientX, el.getBoundingClientRect().left, el.clientWidth);
		draftRatio.current = r;
		setPrefs((p) => ({ ...p, ratio: r }));
	}
	function onDividerUp(e: ReactPointerEvent<HTMLDivElement>) {
		if (!dragging.current) return;
		dragging.current = false;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		if (draftRatio.current !== null) persist({ ...prefsRef.current, ratio: draftRatio.current });
		draftRatio.current = null;
	}
	function onDividerKey(e: ReactKeyboardEvent<HTMLDivElement>) {
		const next = splitStep(ratio, e.key, splitWidth);
		if (next === null) return;
		e.preventDefault();
		const updated = { ...prefsRef.current, ratio: next };
		setPrefs(updated);
		persist(updated);
	}
	function resetSplit() {
		const updated = { ...prefsRef.current, ratio: DEFAULT_SPLIT_RATIO };
		setPrefs(updated);
		persist(updated);
	}

	// The chat keeps its state while hidden: it is hidden, never unmounted.
	const chatEl = useMemo(() => renderChat({ ...chat, transformOutgoing }), [renderChat, chat, transformOutgoing]);
	const chatOpen = prefs.chatOpen;

	const field = "w-full rounded border px-2 py-1 text-sm";
	const railBtn = "flex w-full flex-col items-center gap-0.5 rounded px-1 py-2 text-[11px] leading-tight hover:bg-muted disabled:opacity-50";
	const rail: Array<{ label: string; title: string; Icon: LucideIcon; onClick: () => void; disabled?: boolean; pressed?: boolean }> = [
		{ label: "Selection", title: "Card from selection", Icon: TextSelect, onClick: () => void draftCard("selection"), disabled: busy || selection.text === "" },
		{ label: "Page", title: "Card from page", Icon: FileText, onClick: () => void draftCard("page"), disabled: busy },
		{ label: "Write", title: "Write a card", Icon: PenLine, onClick: () => { setPanelOpen(true); setForm({ page: cardPage(), proposition: "", question: "", answer: "" }); } },
		{ label: "Complete", title: "Complete", Icon: CheckCheck, onClick: () => void complete(), disabled: busy },
		{ label: "Goal", title: "Goal and review", Icon: Target, onClick: () => setPanelOpen((o) => !o), pressed: panelOpen },
	];

	return (
		<div ref={splitRef} className="relative flex min-h-0 min-w-0 flex-1" data-testid="study-view">
			<section aria-label="Document" className="flex min-h-0 min-w-0 flex-col" style={chatOpen ? { width: `${ratio * 100}%` } : { flex: "1 1 auto" }}>
				<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
					<button type="button" aria-label="Previous page" className="rounded border px-2" disabled={page <= 1} onClick={() => go(page - 1)}>‹</button>
					<input
						aria-label="Page number"
						inputMode="numeric"
						className="w-14 rounded border px-2 py-0.5 text-center"
						value={pageText}
						onChange={(e) => setPageText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitPage();
						}}
						onBlur={commitPage}
					/>
					<span>/ {doc.pageCount}</span>
					<button type="button" aria-label="Next page" className="rounded border px-2" disabled={page >= doc.pageCount} onClick={() => go(page + 1)}>›</button>
					<span className="mx-1 h-4 w-px bg-border" aria-hidden />
					<button type="button" aria-label="Zoom out" className="rounded border p-1" disabled={zoom <= 0.5} onClick={() => setZoom((z) => stepZoom(z, -1))}><ZoomOut className="size-4" aria-hidden /></button>
					<span className="w-12 text-center tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span>
					<button type="button" aria-label="Zoom in" className="rounded border p-1" disabled={zoom >= 3} onClick={() => setZoom((z) => stepZoom(z, 1))}><ZoomIn className="size-4" aria-hidden /></button>
					<button type="button" aria-label="Fit width" title="Fit width" className="rounded border p-1" onClick={() => setZoom(1)}><Maximize2 className="size-4" aria-hidden /></button>
					<span className="ml-auto" />
					{chatOpen ? (
						<button type="button" aria-label="Close the chat" className="flex items-center gap-1 rounded border px-2 py-0.5" onClick={() => setChatOpen(false)}>
							<PanelRightClose className="size-4" aria-hidden /> Hide chat
						</button>
					) : null}
					{selection.text !== "" ? (
						<p className="w-full truncate text-muted-foreground" data-testid="study-selection">
							Selected{selection.page !== null ? ` on p. ${selection.page}` : ""}: “{selection.text.length > 120 ? `${selection.text.slice(0, 120)}…` : selection.text}”{" "}
							<button type="button" className="underline" onClick={() => setSelection(NO_SELECTION)}>clear</button>
						</p>
					) : null}
					{message !== null ? (
						<p className={`w-full truncate ${message.error ? "text-destructive" : "text-muted-foreground"}`} data-testid="study-message" role={message.error ? "alert" : undefined}>
							{message.text}
						</p>
					) : null}
				</header>
				<div className="flex min-h-0 flex-1">
					<nav aria-label="Study actions" className="flex w-16 shrink-0 flex-col gap-1 overflow-y-auto border-r p-1">
						{rail.map(({ label, title, Icon, onClick, disabled, pressed }) => (
							<button key={label} type="button" aria-label={title} title={title} aria-pressed={pressed} disabled={disabled} className={railBtn} onClick={onClick}>
								<Icon className="size-5" aria-hidden />
								<span>{label}</span>
							</button>
						))}
					</nav>
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						<PdfViewer documentId={doc.id} jump={jump} zoom={zoom} onVisible={onVisible} onError={showError} />
					</div>
					{panelOpen ? (
						<aside aria-label="Goal and review" className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3 text-sm">
							<div className="flex items-center justify-between">
								<h2 className="font-medium">Cards and goals</h2>
								<button type="button" aria-label="Close the panel" className="rounded border px-2" onClick={() => setPanelOpen(false)}>×</button>
							</div>
							<label className="flex items-center gap-2"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Add to my review</label>
							{form !== null ? (
								<div className="flex flex-col gap-1" data-testid="study-card-form">
									<p className="text-muted-foreground">Card for page {form.page}. Edit, then confirm: the proposition is added to your graph.</p>
									<label>Proposition<textarea className={field} rows={2} value={form.proposition} onChange={(e) => setForm({ ...form, proposition: e.target.value })} /></label>
									<label>Question<textarea className={field} rows={2} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} /></label>
									<label>Answer<textarea className={field} rows={2} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} /></label>
									<div className="flex gap-2">
										<button type="button" className="rounded border px-3 py-1" disabled={busy} onClick={() => void confirmCard()}>Confirm</button>
										<button type="button" className="rounded border px-3 py-1" onClick={() => setForm(null)}>Cancel</button>
									</div>
								</div>
							) : null}
							{drafts.length > 0 ? (
								<div className="flex flex-col gap-1" data-testid="study-drafts">
									<h3 className="font-medium">Proposed cards ({drafts.length})</h3>
									{drafts.map((d) => (
										<label key={d.id} className="flex items-start gap-2">
											<input type="checkbox" checked={chosen.has(d.id)} onChange={(e) => setChosen((prev) => { const next = new Set(prev); if (e.target.checked) next.add(d.id); else next.delete(d.id); return next; })} />
											<span><button type="button" className="underline" onClick={(e) => { e.preventDefault(); go(d.page); }}>p. {d.page}</button> {d.proposition}<br /><span className="text-muted-foreground">{d.question} → {d.answer}</span></span>
										</label>
									))}
									<div className="flex flex-wrap gap-2">
										<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("approve")}>Approve selected</button>
										<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("reject")}>Reject selected</button>
									</div>
								</div>
							) : null}
							<details>
								<summary className="cursor-pointer">Start a goal from this document</summary>
								<div className="mt-1 flex flex-col gap-1">
									<input className={field} placeholder="Goal title" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} />
									<textarea className={field} rows={2} placeholder="The proposition you want to master" value={goal.statement} onChange={(e) => setGoal({ ...goal, statement: e.target.value })} />
									<button type="button" className="self-start rounded border px-3 py-1" disabled={goalBusy || goal.title.trim() === "" || goal.statement.trim() === ""} onClick={() => void startGoal()}>Create goal</button>
								</div>
							</details>
						</aside>
					) : null}
				</div>
			</section>
			{chatOpen ? (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize the reading area and the chat"
					aria-valuenow={Math.round(ratio * 100)}
					aria-valuemin={Math.round(bounds.lo * 100)}
					aria-valuemax={Math.round(bounds.hi * 100)}
					tabIndex={0}
					title="Drag, or use the arrow keys. Double-click to reset."
					className="w-2 shrink-0 cursor-col-resize touch-none bg-border hover:bg-muted-foreground/40 focus-visible:bg-ring focus-visible:outline-none"
					onPointerDown={onDividerDown}
					onPointerMove={onDividerMove}
					onPointerUp={onDividerUp}
					onPointerCancel={onDividerUp}
					onDoubleClick={resetSplit}
					onKeyDown={onDividerKey}
				/>
			) : null}
			<section
				ref={chatColumn}
				aria-label="Chat"
				className={chatOpen ? "flex min-h-0 min-w-0 flex-1 flex-col [&>div:first-child]:h-full!" : "hidden"}
			>
				{chatEl}
			</section>
			{chatOpen ? null : (
				<button
					type="button"
					aria-label="Open the chat"
					title="Open the chat"
					onClick={() => setChatOpen(true)}
					className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-l-md border border-r-0 bg-background px-1.5 py-3 text-sm shadow-sm hover:bg-muted"
				>
					<MessageSquare className="size-4" aria-hidden />
					<span className="[writing-mode:vertical-rl]">Chat</span>
				</button>
			)}
		</div>
	);
}
