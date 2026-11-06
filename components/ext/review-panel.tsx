"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
	answerBody,
	askTutorBody,
	CARD_STATUS_LABEL,
	cardActions,
	cardFormReady,
	type CardView,
	emptyText,
	errorText,
	groupCardsByNode,
	type NodeCards,
	type PlanView,
	RATINGS,
	type Rating,
	type RunnerCard,
	runnerCards,
	secondsSince,
	summaryLine,
} from "./review-logic";
import { postJson, REQUEST_FAILED, type Fetcher } from "./study-logic";

const fetcher: Fetcher = (url, init) => fetch(url, init);

/** One card at a time: the question, the answer only after "Show answer", then the rating. */
export function CardRunner({
	card,
	revealed,
	busy,
	onReveal,
	onRate,
	onAsk,
}: {
	card: RunnerCard;
	revealed: boolean;
	busy: boolean;
	onReveal: () => void;
	onRate: (rating: Rating) => void;
	onAsk: (cardId: string) => void;
}) {
	return (
		<div data-testid="review-card" className="flex flex-col gap-4 rounded-lg border p-4">
			<p className="text-xs text-muted-foreground">{card.name}</p>
			<p className="text-base">{card.question}</p>
			{revealed ? (
				<>
					<div className="rounded bg-muted p-3 text-sm">{card.answer}</div>
					<div role="group" aria-label="How well did you recall it?" className="flex flex-wrap gap-2">
						{RATINGS.map((r) => (
							<button key={r.rating} type="button" disabled={busy} className="rounded border px-3 py-1" onClick={() => onRate(r.rating)}>
								{r.label}
							</button>
						))}
					</div>
				</>
			) : (
				<button type="button" className="self-start rounded border px-3 py-1" onClick={onReveal}>
					Show answer
				</button>
			)}
			<button type="button" className="self-start text-sm underline" onClick={() => onAsk(card.cardId)}>
				Ask the tutor
			</button>
		</div>
	);
}

/** The runner section as drawn: heading, summary, the empty state or the current card, and any error. */
export function RunnerView({
	plan,
	loadError,
	queue,
	revealed,
	busy,
	error,
	onReveal,
	onRate,
	onAsk,
}: {
	plan: PlanView | null;
	loadError: string | null;
	queue: RunnerCard[];
	revealed: boolean;
	busy: boolean;
	error: string | null;
	onReveal: () => void;
	onRate: (rating: Rating) => void;
	onAsk: (cardId: string) => void;
}) {
	return (
		<section aria-labelledby="review-today" className="flex flex-col gap-3">
			<h2 id="review-today" className="font-medium">Today&apos;s review</h2>
			{loadError !== null ? <p className="text-sm text-destructive">{loadError}</p> : null}
			{loadError === null && plan === null ? <p className="text-sm text-muted-foreground">Loading today&apos;s plan…</p> : null}
			{plan !== null ? (
				<>
					<p className="text-sm text-muted-foreground">{summaryLine(plan)}</p>
					{queue.length === 0 ? (
						<p className="text-sm">{emptyText(plan)}</p>
					) : (
						<CardRunner card={queue[0]!} revealed={revealed} busy={busy} onReveal={onReveal} onRate={onRate} onAsk={onAsk} />
					)}
				</>
			) : null}
			{error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
		</section>
	);
}

/** Loads today's plan and runs the cards in it. No model is called. */
export function ReviewRunner({ reloadKey }: { reloadKey: number }) {
	const router = useRouter();
	const [plan, setPlan] = useState<PlanView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [queue, setQueue] = useState<RunnerCard[]>([]);
	const [revealed, setRevealed] = useState(false);
	const [shownAt, setShownAt] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/ext/review/plan");
			if (!res.ok) throw new Error("plan");
			const json = (await res.json()) as PlanView;
			setPlan(json);
			setQueue(runnerCards(json));
			setRevealed(false);
			setShownAt(Date.now());
			setLoadError(null);
		} catch {
			setLoadError("Could not load today's plan. Reload the page to try again.");
		}
	}, []);
	useEffect(() => void load(), [load, reloadKey]);

	async function rate(rating: Rating) {
		const card = queue[0];
		if (card === undefined || busy) return;
		setBusy(true);
		setError(null);
		const res = await postJson(fetcher, "/api/ext/review/answer", answerBody(card.nodeId, rating, secondsSince(shownAt, Date.now())));
		setBusy(false);
		if (!res.ok) {
			setError(errorText(res.json));
			return;
		}
		setQueue((q) => q.slice(1));
		setRevealed(false);
		setShownAt(Date.now());
	}

	async function ask(cardId: string) {
		setError(null);
		const res = await postJson(fetcher, "/api/ext/review/session", askTutorBody(cardId));
		if (res.ok && typeof res.json.chatId === "string") router.push(`/chat/${res.json.chatId}`);
		else setError(res.ok ? REQUEST_FAILED : errorText(res.json));
	}

	return (
		<RunnerView
			plan={plan}
			loadError={loadError}
			queue={queue}
			revealed={revealed}
			busy={busy}
			error={error}
			onReveal={() => setRevealed(true)}
			onRate={(r) => void rate(r)}
			onAsk={(id) => void ask(id)}
		/>
	);
}

/** The cards of each node, with approve / reject for drafts and retire for active cards. */
export function CardGroups({
	groups,
	busy,
	onAction,
	onAsk,
}: {
	groups: NodeCards[];
	busy: boolean;
	onAction: (cardId: string, action: "approve" | "retire") => void;
	onAsk: (cardId: string) => void;
}) {
	if (groups.length === 0) return <p className="text-sm text-muted-foreground">No cards yet. Add one below, or ask the tutor to draft one from a conversation.</p>;
	return (
		<div className="flex flex-col gap-4">
			{groups.map((g) => (
				<div key={g.nodeId} className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">{g.name}</h3>
					<ul className="flex flex-col gap-2">
						{g.cards.map((c) => (
							<li key={c.id} className="flex flex-col gap-1 rounded border p-3 text-sm">
								<span className="text-xs text-muted-foreground">
									{CARD_STATUS_LABEL[c.status]}
									{c.author === "agent" ? " · drafted by the tutor" : ""}
								</span>
								<span>{c.question}</span>
								<span className="text-muted-foreground">Answer: {c.answer}</span>
								<span className="flex flex-wrap gap-2">
									{cardActions(c).map((a) => (
										<button key={a} type="button" disabled={busy} className="rounded border px-2 py-0.5" onClick={() => onAction(c.id, a)}>
											{a === "approve" ? "Approve" : c.status === "draft" ? "Reject" : "Retire"}
										</button>
									))}
									<button type="button" className="rounded border px-2 py-0.5" onClick={() => onAsk(c.id)}>
										Ask the tutor
									</button>
								</span>
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	);
}

/** The fixed-card editor: a node, a question and an answer, all with visible labels. */
export function CardForm({
	nodes,
	nodeId,
	question,
	answer,
	busy,
	onNodeId,
	onQuestion,
	onAnswer,
	onSubmit,
}: {
	nodes: Array<{ id: string; name: string }>;
	nodeId: string;
	question: string;
	answer: string;
	busy: boolean;
	onNodeId: (v: string) => void;
	onQuestion: (v: string) => void;
	onAnswer: (v: string) => void;
	onSubmit: () => void;
}) {
	const ready = cardFormReady(nodeId, question, answer);
	return (
		<form
			className="flex flex-col gap-2 rounded border p-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (!busy && ready) onSubmit();
			}}
		>
			<h3 className="text-sm font-medium">Add a card</h3>
			<label className="flex flex-col gap-1 text-sm">
				Node
				<select className="rounded border px-2 py-1" value={nodeId} onChange={(e) => onNodeId(e.target.value)}>
					<option value="">Choose a node</option>
					{nodes.map((n) => (
						<option key={n.id} value={n.id}>{n.name}</option>
					))}
				</select>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				Question
				<textarea className="min-h-16 rounded border px-2 py-1" value={question} onChange={(e) => onQuestion(e.target.value)} />
			</label>
			<label className="flex flex-col gap-1 text-sm">
				Answer
				<textarea className="min-h-16 rounded border px-2 py-1" value={answer} onChange={(e) => onAnswer(e.target.value)} />
			</label>
			<button type="submit" disabled={busy || !ready} className="self-start rounded border px-3 py-1">
				Add card
			</button>
		</form>
	);
}

/** The card list and the editor for a fixed card the learner writes. */
export function CardsSection({ cards, nodes, onChanged }: { cards: CardView[]; nodes: Array<{ id: string; name: string }>; onChanged: () => void }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [nodeId, setNodeId] = useState("");
	const [question, setQuestion] = useState("");
	const [answer, setAnswer] = useState("");
	const groups = groupCardsByNode(cards, new Map(nodes.map((n) => [n.id, n.name] as const)));

	function refreshed() {
		onChanged();
		router.refresh();
	}

	async function create() {
		setBusy(true);
		setError(null);
		const res = await postJson(fetcher, "/api/ext/cards", { nodeId, question: question.trim(), answer: answer.trim() });
		setBusy(false);
		if (!res.ok) {
			setError(errorText(res.json));
			return;
		}
		setQuestion("");
		setAnswer("");
		refreshed();
	}

	async function act(cardId: string, action: "approve" | "retire") {
		setBusy(true);
		setError(null);
		const res = await patchCard(cardId, action);
		setBusy(false);
		if (!res.ok) setError(errorText(res.json));
		else refreshed();
	}

	async function ask(cardId: string) {
		setError(null);
		const res = await postJson(fetcher, "/api/ext/review/session", askTutorBody(cardId));
		if (res.ok && typeof res.json.chatId === "string") router.push(`/chat/${res.json.chatId}`);
		else setError(res.ok ? REQUEST_FAILED : errorText(res.json));
	}

	return (
		<section aria-labelledby="review-cards" className="flex flex-col gap-4">
			<div>
				<h2 id="review-cards" className="font-medium">Cards</h2>
				<p className="text-sm text-muted-foreground">
					Cards are grouped by node. A card the tutor drafted is not scheduled until you approve it; rejecting it retires it.
				</p>
			</div>
			{error !== null ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
			<CardGroups groups={groups} busy={busy} onAction={(id, a) => void act(id, a)} onAsk={(id) => void ask(id)} />
			<CardForm
				nodes={nodes}
				nodeId={nodeId}
				question={question}
				answer={answer}
				busy={busy}
				onNodeId={setNodeId}
				onQuestion={setQuestion}
				onAnswer={setAnswer}
				onSubmit={() => void create()}
			/>
		</section>
	);
}

async function patchCard(cardId: string, action: "approve" | "retire"): Promise<{ ok: boolean; json: Record<string, unknown> }> {
	let res: Response;
	try {
		res = await fetch(`/api/ext/cards/${encodeURIComponent(cardId)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
	} catch {
		return { ok: false, json: { error: REQUEST_FAILED } };
	}
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { ok: res.ok, json };
}

/** The Review page body: the runner first, then the card list. */
export function ReviewPanel({ cards, nodes }: { cards: CardView[]; nodes: Array<{ id: string; name: string }> }) {
	const [reloadKey, setReloadKey] = useState(0);
	return (
		<div className="flex flex-col gap-8">
			<ReviewRunner reloadKey={reloadKey} />
			<CardsSection cards={cards} nodes={nodes} onChanged={() => setReloadKey((k) => k + 1)} />
		</div>
	);
}
