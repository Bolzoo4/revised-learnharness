// components/ext/node-panel-view.tsx
"use client";

import { useState, type ReactNode } from "react";
import {
	linkifyNodeLinks,
	NODE_ACTIONS,
	NODE_HREF_PREFIX,
	radialPositions,
	type NodeAction,
	type NodePanelData,
	type NodeRef,
} from "@/src/core";

/**
 * The node panel, presentational half (REQ-node-10 to REQ-node-14).
 * Functional markup only: the visual design is done in the UI session. The
 * body renderer is injected so the container can use the app's markdown and
 * math renderer while tests use the plain default.
 */

export interface NodePanelViewProps {
	data: NodePanelData;
	depth: 1 | 2;
	canBack: boolean;
	canForward: boolean;
	generating: boolean;
	error: string | null;
	onBack(): void;
	onForward(): void;
	onClose(): void;
	onNavigate(nodeId: string): void;
	onDepth(depth: 1 | 2): void;
	onAction(action: NodeAction): void;
	onGenerate(): void;
	onSaveEdit(body: string): void;
	onCreateCard(question: string, answer: string): void;
	onDecide(decision: "approved" | "rejected", version: number): void;
	renderBody?: (markdown: string) => ReactNode;
}

const ACTION_LABELS: Record<NodeAction, string> = {
	createCard: "Create card",
	pin: "Pin",
	retire: "Retire",
	startReview: "Start review",
	askInChat: "Ask in chat",
	useAsGoalTarget: "Use as goal target",
	verifyNow: "Verify now",
};

const RING = 52;

function Section({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
	return (
		<section data-testid={testId} className="border-t px-4 py-3">
			<h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

function NodeButton({ node, onNavigate }: { node: NodeRef; onNavigate(id: string): void }) {
	return (
		<button type="button" className="underline decoration-dotted" onClick={() => onNavigate(node.id)}>
			{node.name}
		</button>
	);
}

function NodeList({ nodes, onNavigate }: { nodes: NodeRef[]; onNavigate(id: string): void }) {
	return (
		<>
			{nodes.map((n, i) => (
				<span key={n.id}>
					{i > 0 ? ", " : ""}
					<NodeButton node={n} onNavigate={onNavigate} />
				</span>
			))}
		</>
	);
}

export function NodePanelView(p: NodePanelViewProps) {
	const { data } = p;
	const { explanation: ex } = data;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [cardForm, setCardForm] = useState<{ question: string; answer: string } | null>(null);
	const plain = (md: string): ReactNode => <div className="whitespace-pre-wrap">{md}</div>;
	const render = p.renderBody ?? plain;

	// Clicks on rendered node links bubble to this wrapper (the markdown renderer owns the anchors).
	const interceptNodeLinks = (e: { target: EventTarget | null; preventDefault(): void }) => {
		const anchor = (e.target as Element | null)?.closest?.("a");
		const href = anchor?.getAttribute("href");
		if (href?.startsWith(NODE_HREF_PREFIX)) {
			e.preventDefault();
			p.onNavigate(href.slice(NODE_HREF_PREFIX.length));
		}
	};
	const body = (markdown: string) => <div onClick={interceptNodeLinks}>{render(linkifyNodeLinks(markdown, ex.linkNames))}</div>;

	const visible = data.neighbourhood.nodes.filter((n) => n.depth <= p.depth);
	const visibleIds = new Set(visible.map((n) => n.id));
	const positions = radialPositions(visible, RING);

	return (
		<div data-testid="node-panel-view" className="text-sm">
			<header className="flex items-center gap-2 px-4 py-3">
				<button type="button" data-testid="panel-back" disabled={!p.canBack} onClick={p.onBack} aria-label="Back">←</button>
				<button type="button" data-testid="panel-forward" disabled={!p.canForward} onClick={p.onForward} aria-label="Forward">→</button>
				<h2 className="min-w-0 flex-1 truncate text-base font-medium">{data.node.name}</h2>
				<button type="button" data-testid="panel-close" onClick={p.onClose} aria-label="Close">×</button>
			</header>

			{p.error !== null ? (
				<div data-testid="panel-error" role="alert" className="px-4 pb-2 text-destructive">
					{p.error}
				</div>
			) : null}

			<Section title="Explanation" testId="panel-explanation">
				{ex.current !== null && !editing ? (
					<>
						<div className="mb-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
							<span>{ex.current.author === "user" ? "written by you" : "written by the agent"}</span>
							<span>{ex.form} form</span>
							{ex.state === "stale" ? <span data-testid="explanation-stale">out of date: the arguments changed</span> : null}
							{ex.current.noSource ? <span data-testid="explanation-nosource">no source context</span> : null}
						</div>
						{body(ex.current.body)}
						<button
							type="button"
							data-testid="explanation-edit"
							className="mt-1 text-xs underline"
							onClick={() => { setDraft(ex.current?.body ?? ""); setEditing(true); }}
						>
							Edit
						</button>
					</>
				) : null}

				{editing ? (
					<div>
						<textarea
							data-testid="explanation-editor"
							className="h-48 w-full rounded border bg-background p-2 font-mono text-xs"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
						/>
						<button type="button" data-testid="explanation-save" onClick={() => { p.onSaveEdit(draft); setEditing(false); }}>Save</button>{" "}
						<button type="button" onClick={() => setEditing(false)}>Cancel</button>
					</div>
				) : null}

				{ex.current === null && !editing ? (
					p.generating ? (
						<p data-testid="explanation-generating" className="text-muted-foreground">Writing the explanation…</p>
					) : ex.ceiling ? (
						<p data-testid="explanation-ceiling" className="text-muted-foreground">
							No explanation yet: the daily cost ceiling is reached, so none is written now. The statement below is all there is for the moment.
						</p>
					) : (
						<>
							<button type="button" data-testid="explanation-generate" onClick={p.onGenerate}>Generate explanation</button>{" "}
							<button type="button" onClick={() => { setDraft(""); setEditing(true); }}>Write my own</button>
						</>
					)
				) : null}

				{ex.state === "stale" && ex.ceiling ? (
					<p data-testid="explanation-ceiling" className="mt-1 text-xs text-muted-foreground">
						The daily cost ceiling is reached, so the out-of-date text is not rewritten now.
					</p>
				) : null}

				{ex.proposal !== null ? (
					<div data-testid="explanation-proposal" className="mt-2 rounded border p-2">
						<div className="mb-1 text-xs text-muted-foreground">The agent proposes a new version of your text.</div>
						{body(ex.proposal.body)}
						<button type="button" data-testid="proposal-approve" onClick={() => p.onDecide("approved", ex.proposal?.version ?? 0)}>Approve</button>{" "}
						<button type="button" data-testid="proposal-reject" onClick={() => p.onDecide("rejected", ex.proposal?.version ?? 0)}>Reject</button>
					</div>
				) : null}
			</Section>

			<Section title="Statement" testId="panel-statement">
				<p>{data.node.statement}</p>
				{data.node.aliases.length > 0 ? <p className="text-xs text-muted-foreground">Also: {data.node.aliases.join(" | ")}</p> : null}
				<p data-testid="panel-trust" className="mt-1">
					Trust: <strong>{data.trust.level}</strong>
				</p>
				{data.trust.evidence.map((e, i) => (
					<blockquote key={i} className="mt-1 border-l pl-2 text-xs">
						{e.quote}
						<div className="text-muted-foreground">
							{e.stance}, {e.tier}, {e.sourceId} {e.locator}
						</div>
					</blockquote>
				))}
			</Section>

			<Section title={data.concluding.length > 1 ? "Alternative arguments" : "Argument"} testId="panel-arguments">
				{data.concluding.length === 0 ? <p className="text-muted-foreground">No argument concludes this node.</p> : null}
				{data.concluding.map((c) => (
					<p key={c.chainId}>
						<NodeList nodes={c.premises} onNavigate={p.onNavigate} /> together imply this node.
					</p>
				))}
				{data.usedAsPremise.length > 0 ? <h4 className="mt-2 text-xs text-muted-foreground">Used as a premise</h4> : null}
				{data.usedAsPremise.map((u) => (
					<p key={u.chainId}>
						{u.coPremises.length > 0 ? <><NodeList nodes={u.coPremises} onNavigate={p.onNavigate} /> with this, </> : "Alone, "}
						gives <NodeButton node={u.conclusion} onNavigate={p.onNavigate} />.
					</p>
				))}
			</Section>

			<Section title="Lectures that cite it" testId="panel-lectures">
				{data.citingLectures.length === 0 ? <p className="text-muted-foreground">None.</p> : data.citingLectures.map((l) => <p key={l.lectureId}>{l.title}</p>)}
			</Section>

			<Section title="Source in your documents" testId="panel-study-sources">
				{data.studySources.length === 0 ? (
					<p className="text-muted-foreground">None.</p>
				) : (
					data.studySources.map((s) => (
						<p key={`${s.documentId}:${s.page}`}>
							<a className="underline" href={`/study/${s.documentId}?page=${s.page}`}>
								{s.title}, p. {s.page}
							</a>
						</p>
					))
				)}
			</Section>

			<Section title="Mentioned in explanations of" testId="panel-mentions">
				{data.mentionedBy.length === 0 ? <p className="text-muted-foreground">None.</p> : <NodeList nodes={data.mentionedBy} onNavigate={p.onNavigate} />}
			</Section>

			<Section title="Cards and review" testId="panel-cards">
				{data.cards.length === 0 ? <p className="text-muted-foreground">No cards.</p> : data.cards.map((c) => <p key={c.cardId}>{c.question} ({c.status})</p>)}
				{data.review !== null ? (
					<p className="text-xs text-muted-foreground">
						Reviews: {data.review.reps}; due: {data.review.dueAt ?? "not scheduled"}
						{data.review.pinned ? "; pinned" : ""}
						{data.review.retired ? "; retired" : ""}
					</p>
				) : null}
			</Section>

			<Section title="Goals" testId="panel-goals">
				{data.goals.length === 0 ? <p className="text-muted-foreground">In no goal.</p> : data.goals.map((g) => <p key={g.id}>{g.title} ({g.status}{g.isTarget ? ", target" : ""})</p>)}
			</Section>

			<Section title="Neighbourhood" testId="panel-minigraph">
				<div className="mb-1 text-xs">
					<button type="button" data-testid="minigraph-depth-1" disabled={p.depth === 1} onClick={() => p.onDepth(1)}>Depth 1</button>{" "}
					<button type="button" data-testid="minigraph-depth-2" disabled={p.depth === 2} onClick={() => p.onDepth(2)}>Depth 2</button>
				</div>
				<svg viewBox="-170 -140 340 280" className="h-64 w-full" role="img" aria-label="Neighbourhood of this node">
					{data.neighbourhood.edges
						.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
						.map((e) => {
							const a = positions[e.from];
							const b = positions[e.to];
							return a && b ? <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.4} /> : null;
						})}
					{visible.map((n) => {
						const pos = positions[n.id];
						if (!pos) return null;
						return (
							<g
								key={n.id}
								data-testid={`minigraph-node-${n.id}`}
								transform={`translate(${pos.x} ${pos.y})`}
								style={{ cursor: n.depth === 0 ? "default" : "pointer" }}
								onClick={() => { if (n.depth !== 0) p.onNavigate(n.id); }}
							>
								<circle r={n.depth === 0 ? 10 : 7} fill="currentColor" fillOpacity={n.depth === 0 ? 0.9 : 0.5} />
								<text y={n.depth === 0 ? -14 : -11} textAnchor="middle" fontSize="9" fill="currentColor">
									{n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}
								</text>
							</g>
						);
					})}
				</svg>
			</Section>

			<Section title="Actions" testId="panel-actions">
				<div className="flex flex-wrap gap-2">
					{NODE_ACTIONS.map((a) => (
						<button
							key={a}
							type="button"
							data-testid={`action-${a}`}
							disabled={!data.availableActions.includes(a)}
							title={data.availableActions.includes(a) ? undefined : "Not available yet"}
							onClick={() => (a === "createCard" ? setCardForm({ question: "", answer: "" }) : p.onAction(a))}
						>
							{ACTION_LABELS[a]}
						</button>
					))}
				</div>
				{cardForm !== null ? (
					<div data-testid="card-form" className="mt-2 space-y-1">
						<input
							className="w-full rounded border bg-background p-1 text-xs"
							placeholder="Question"
							value={cardForm.question}
							onChange={(e) => setCardForm({ ...cardForm, question: e.target.value })}
						/>
						<textarea
							className="h-20 w-full rounded border bg-background p-1 text-xs"
							placeholder="Answer"
							value={cardForm.answer}
							onChange={(e) => setCardForm({ ...cardForm, answer: e.target.value })}
						/>
						<button
							type="button"
							data-testid="card-save"
							disabled={cardForm.question.trim() === "" || cardForm.answer.trim() === ""}
							onClick={() => {
								p.onCreateCard(cardForm.question.trim(), cardForm.answer.trim());
								setCardForm(null);
							}}
						>
							Save card
						</button>{" "}
						<button type="button" data-testid="card-cancel" onClick={() => setCardForm(null)}>Cancel</button>
					</div>
				) : null}
			</Section>
		</div>
	);
}
