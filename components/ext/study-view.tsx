"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { encodeStudyContext } from "@/src/core";
import { Chat } from "@/components/chat";
import { pageFromPoint } from "./citation-click";
import { openNodePanel } from "./open-node";
import { PdfViewer } from "./pdf-viewer";
import { draftsOf, pageFromInput, postJson, REQUEST_FAILED, type DraftRowLike } from "./study-logic";

type ChatProps = Pick<
	ComponentProps<typeof Chat>,
	"chatId" | "title" | "initialMessages" | "initialError" | "initialConfigured" | "initiallyInFlight" | "initiallyCompacting"
>;

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

/** Every request goes through here: it never rejects, and a server error is shown as REQUEST_FAILED, never as the server's text. */
const post = (url: string, body: unknown) => postJson((u, init) => fetch(u, init), url, body);

/**
 * The study session (REQ-study-04): the PDF on the left, the document's one
 * conversation on the right. Every message the learner sends is prefixed with
 * the page and the selection (REQ-study-06); `(p. N)` in the conversation
 * moves the viewer (REQ-study-07). Layout is functional only; the visual
 * design belongs to the UI session.
 */
export function StudyView({ document: doc, startPage, chat }: { document: { id: string; title: string; pageCount: number }; startPage: number; chat: ChatProps }) {
	const [page, setPage] = useState(startPage);
	const [selection, setSelection] = useState("");
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
	const chatColumn = useRef<HTMLDivElement>(null);
	const pageRef = useRef(page);
	const selectionRef = useRef(selection);
	pageRef.current = page;
	selectionRef.current = selection;

	// Reading events (REQ-study-03): a visit on every page change, a close when the window is hidden or closed.
	const report = useCallback((body: Record<string, unknown>, keepalive = false) => {
		void fetch("/api/ext/study/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: doc.id, ...body }), keepalive }).catch(() => undefined);
	}, [doc.id]);
	useEffect(() => {
		report({ kind: "visit", page });
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
			if (text !== "" && !inField) setSelection(text);
		};
		document.addEventListener("selectionchange", onSelect);
		return () => document.removeEventListener("selectionchange", onSelect);
	}, []);

	// A click on "(p. N)" in the conversation moves the viewer.
	useEffect(() => {
		const el = chatColumn.current;
		if (!el) return;
		const onClick = (e: MouseEvent) => {
			const cited = pageFromPoint(document, e.clientX, e.clientY);
			if (cited !== null && cited <= doc.pageCount) setPage(cited);
		};
		el.addEventListener("click", onClick);
		return () => el.removeEventListener("click", onClick);
	}, [doc.pageCount]);

	const transformOutgoing = useCallback(
		(text: string) => {
			const out = encodeStudyContext({ documentId: doc.id, page: pageRef.current, selection: selectionRef.current }, text);
			setSelection("");
			return out;
		},
		[doc.id],
	);

	const go = (p: number) => setPage(Math.min(Math.max(1, p), doc.pageCount));
	const say = (text: string) => setMessage({ text, error: false });
	// Stable identity: PdfViewer lists onError in its load effect, so a new function would reload the PDF on every render.
	const showError = useCallback((text: string) => setMessage({ text, error: true }), []);

	// The selection belongs to the page it was made on.
	useEffect(() => {
		setSelection("");
	}, [page]);
	// The page box mirrors the page; typing is local until Enter or blur commits it.
	useEffect(() => {
		setPageText(String(page));
	}, [page]);
	function commitPage() {
		const target = pageFromInput(pageText, doc.pageCount);
		if (target === null) return setPageText(String(page));
		go(target);
		setPageText(String(target));
	}

	async function draftCard(from: "selection" | "page") {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "draft", documentId: doc.id, page, ...(from === "selection" ? { selection } : {}) });
		setBusy(false);
		if (!r.ok) return showError(REQUEST_FAILED);
		setForm({ page, proposition: String(r.json.proposition ?? ""), question: String(r.json.question ?? ""), answer: String(r.json.answer ?? "") });
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

	const field = "w-full rounded border px-2 py-1 text-sm";
	return (
		<div className="flex h-dvh min-h-0 w-full" data-testid="study-view">
			<section className="flex min-h-0 w-1/2 flex-col border-r">
				<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
					<strong className="mr-2 truncate">{doc.title}</strong>
					<button type="button" aria-label="Previous page" className="rounded border px-2" disabled={page <= 1} onClick={() => go(page - 1)}>‹</button>
					<input
						aria-label="Page"
						inputMode="numeric"
						className="w-14 rounded border px-1 text-center"
						value={pageText}
						onChange={(e) => setPageText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitPage();
						}}
						onBlur={commitPage}
					/>
					<span>/ {doc.pageCount}</span>
					<button type="button" aria-label="Next page" className="rounded border px-2" disabled={page >= doc.pageCount} onClick={() => go(page + 1)}>›</button>
				</header>
				<div className="min-h-0 flex-1 overflow-auto bg-muted/30">
					<PdfViewer documentId={doc.id} page={page} onError={showError} />
				</div>
				<div className="max-h-[45%] overflow-auto border-t px-3 py-2 text-sm">
					<div className="flex flex-wrap items-center gap-2">
						<button type="button" className="rounded border px-2 py-1" disabled={busy || selection === ""} onClick={() => void draftCard("selection")}>Card from selection</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void draftCard("page")}>Card from page</button>
						<button type="button" className="rounded border px-2 py-1" onClick={() => setForm({ page, proposition: "", question: "", answer: "" })}>Write a card</button>
						<button type="button" className="rounded border px-2 py-1" disabled={busy} onClick={() => void complete()}>Complete</button>
						<label className="flex items-center gap-1"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Add to my review</label>
					</div>
					{selection !== "" ? (
						<p className="mt-2 text-muted-foreground" data-testid="study-selection">
							Selected: “{selection.length > 120 ? `${selection.slice(0, 120)}…` : selection}” <button type="button" className="underline" onClick={() => setSelection("")}>clear</button>
						</p>
					) : null}
					{message !== null ? (
						<p className={`mt-2 ${message.error ? "text-destructive" : ""}`} data-testid="study-message" role={message.error ? "alert" : undefined}>
							{message.text}
						</p>
					) : null}
					{form !== null ? (
						<div className="mt-2 flex flex-col gap-1" data-testid="study-card-form">
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
						<div className="mt-3 flex flex-col gap-1" data-testid="study-drafts">
							<h3 className="font-medium">Proposed cards ({drafts.length})</h3>
							{drafts.map((d) => (
								<label key={d.id} className="flex items-start gap-2">
									<input type="checkbox" checked={chosen.has(d.id)} onChange={(e) => setChosen((prev) => { const next = new Set(prev); if (e.target.checked) next.add(d.id); else next.delete(d.id); return next; })} />
									<span><button type="button" className="underline" onClick={(e) => { e.preventDefault(); go(d.page); }}>p. {d.page}</button> {d.proposition}<br /><span className="text-muted-foreground">{d.question} → {d.answer}</span></span>
								</label>
							))}
							<div className="flex gap-2">
								<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("approve")}>Approve selected</button>
								<button type="button" className="rounded border px-3 py-1" disabled={busy || chosen.size === 0} onClick={() => void decide("reject")}>Reject selected</button>
							</div>
						</div>
					) : null}
					<details className="mt-3">
						<summary className="cursor-pointer">Start a goal from this document</summary>
						<div className="mt-1 flex flex-col gap-1">
							<input className={field} placeholder="Goal title" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} />
							<textarea className={field} rows={2} placeholder="The proposition you want to master" value={goal.statement} onChange={(e) => setGoal({ ...goal, statement: e.target.value })} />
							<button type="button" className="self-start rounded border px-3 py-1" disabled={goalBusy || goal.title.trim() === "" || goal.statement.trim() === ""} onClick={() => void startGoal()}>Create goal</button>
						</div>
					</details>
				</div>
			</section>
			<section ref={chatColumn} className="min-h-0 w-1/2 overflow-auto">
				<Chat key={chat.chatId} {...chat} kind="teach" transformOutgoing={transformOutgoing} />
			</section>
		</div>
	);
}
