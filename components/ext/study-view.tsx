"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { encodeStudyContext } from "@/src/core";
import { Chat } from "@/components/chat";
import { pageFromPoint } from "./citation-click";
import { openNodePanel } from "./open-node";
import { PdfViewer } from "./pdf-viewer";

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
interface DraftRow {
	id: string;
	page: number;
	proposition: string;
	question: string;
	answer: string;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
	const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const errorOf = (json: Record<string, unknown>): string => (typeof json.error === "string" ? json.error : "Request failed.");

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
	const [message, setMessage] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<DraftRow[]>([]);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [goal, setGoal] = useState({ title: "", statement: "" });
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

	async function draftCard(from: "selection" | "page") {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "draft", documentId: doc.id, page, ...(from === "selection" ? { selection } : {}) });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setForm({ page, proposition: String(r.json.proposition ?? ""), question: String(r.json.question ?? ""), answer: String(r.json.answer ?? "") });
	}
	async function confirmCard() {
		if (form === null) return;
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/cards", { action: "confirm", documentId: doc.id, ...form, pin });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setForm(null);
		setMessage("Card added.");
		if (typeof r.json.nodeId === "string") openNodePanel(r.json.nodeId);
	}
	async function loadDrafts() {
		const res = await fetch(`/api/ext/study/drafts?documentId=${doc.id}`);
		if (res.ok) setDrafts(((await res.json()) as { drafts: DraftRow[] }).drafts);
		setChosen(new Set());
	}
	useEffect(() => void loadDrafts(), []);
	async function complete() {
		setBusy(true);
		setMessage(null);
		const r = await post("/api/ext/study/drafts", { action: "complete", documentId: doc.id });
		setBusy(false);
		if (!r.ok) return setMessage(errorOf(r.json));
		setMessage(`${String(r.json.proposed)} draft(s) proposed from ${(r.json.pages as number[]).length} page(s).${r.json.ceilingReached === true ? " The daily cost ceiling was reached: run it again tomorrow for the rest." : ""}`);
		await loadDrafts();
	}
	async function decide(kind: "approve" | "reject") {
		const ids = [...chosen];
		if (ids.length === 0) return;
		setBusy(true);
		const r = await post("/api/ext/study/drafts", { action: "decide", ...(kind === "approve" ? { approve: ids.map((draftId) => ({ draftId, pin })) } : { reject: ids }) });
		setBusy(false);
		if (!r.ok) setMessage(errorOf(r.json));
		else {
			const failed = (r.json.failed as Array<{ error: string }>).length;
			setMessage(`${kind === "approve" ? (r.json.approved as unknown[]).length : (r.json.rejected as unknown[]).length} done${failed > 0 ? `, ${failed} failed` : ""}.`);
		}
		await loadDrafts();
	}
	async function startGoal() {
		const r = await post("/api/ext/study/goal", { documentId: doc.id, ...goal });
		setMessage(r.ok ? "Goal created." : errorOf(r.json));
		if (r.ok) setGoal({ title: "", statement: "" });
	}

	const field = "w-full rounded border px-2 py-1 text-sm";
	return (
		<div className="flex h-dvh min-h-0 w-full" data-testid="study-view">
			<section className="flex min-h-0 w-1/2 flex-col border-r">
				<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
					<strong className="mr-2 truncate">{doc.title}</strong>
					<button type="button" className="rounded border px-2" disabled={page <= 1} onClick={() => go(page - 1)}>‹</button>
					<input aria-label="Page" className="w-14 rounded border px-1 text-center" value={page} onChange={(e) => go(Number(e.target.value) || 1)} />
					<span>/ {doc.pageCount}</span>
					<button type="button" className="rounded border px-2" disabled={page >= doc.pageCount} onClick={() => go(page + 1)}>›</button>
				</header>
				<div className="min-h-0 flex-1 overflow-auto bg-muted/30">
					<PdfViewer documentId={doc.id} page={page} onError={setMessage} />
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
					{message !== null ? <p className="mt-2" data-testid="study-message">{message}</p> : null}
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
							<button type="button" className="self-start rounded border px-3 py-1" disabled={goal.title.trim() === "" || goal.statement.trim() === ""} onClick={() => void startGoal()}>Create goal</button>
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
