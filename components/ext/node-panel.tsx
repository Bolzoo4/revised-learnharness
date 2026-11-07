// components/ext/node-panel.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	EMPTY_HISTORY,
	historyBack,
	historyCanBack,
	historyCanForward,
	historyCurrent,
	historyForward,
	historyOpen,
	type NodeAction,
	type NodePanelData,
} from "@/src/core";
import { NodePanelView } from "./node-panel-view";

export interface PanelRequest {
	nodeId: string;
	seq: number;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(path, { cache: "no-store", ...init });
	const json: unknown = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
	return json;
}

const post = (nodeId: string, route: "explanation" | "actions", body: unknown) =>
	api(`/api/ext/nodes/${encodeURIComponent(nodeId)}/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

export function NodePanel({ request, onClose }: { request: PanelRequest; onClose(): void }) {
	const [history, setHistory] = useState(() => historyOpen(EMPTY_HISTORY, request.nodeId));
	const [data, setData] = useState<NodePanelData | null>(null);
	const [depth, setDepth] = useState<1 | 2>(1);
	const [generating, setGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** One automatic generation per (node, state) per panel session: a refused text must not loop. */
	const attempted = useRef(new Set<string>());
	const nodeId = historyCurrent(history);

	useEffect(() => {
		setHistory((h) => historyOpen(h, request.nodeId));
	}, [request]);

	const load = useCallback(
		async (id: string) => (await api(`/api/ext/nodes/${encodeURIComponent(id)}/panel`)) as NodePanelData,
		[],
	);

	useEffect(() => {
		if (nodeId === null) return;
		let cancelled = false;
		setError(null);
		(async () => {
			try {
				let next = await load(nodeId);
				if (cancelled) return;
				setData(next);
				const key = `${nodeId}:${next.explanation.state}`;
				const needsText = next.explanation.state !== "current" && !next.explanation.ceiling && next.explanation.proposal === null;
				if (needsText && !attempted.current.has(key)) {
					attempted.current.add(key);
					setGenerating(true);
					await post(nodeId, "explanation", { action: "generate" });
					next = await load(nodeId);
					if (!cancelled) setData(next);
				}
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (!cancelled) setGenerating(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [nodeId, load]);

	const refresh = useCallback(async () => {
		if (nodeId === null) return;
		try {
			setData(await load(nodeId));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [nodeId, load]);

	const guarded = async (run: () => Promise<unknown>) => {
		setError(null);
		try {
			await run();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	if (data === null || nodeId === null) {
		return <div className="p-4 text-sm">{error ?? "Loading…"}</div>;
	}

	const askInChat = async () => {
		const chat = (await api("/api/chats", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: `About: ${data.node.name}`,
				graphContext: { propositions: [{ id: data.node.id, name: data.node.name, statement: data.node.statement }] },
			}),
		})) as { id: string };
		window.location.href = `/chat/${chat.id}?prompt=${encodeURIComponent(`Explain "${data.node.name}" to me and check what I understand.`)}`;
	};

	return (
		<NodePanelView
			data={data}
			depth={depth}
			canBack={historyCanBack(history)}
			canForward={historyCanForward(history)}
			generating={generating}
			error={error}
			onBack={() => setHistory(historyBack)}
			onForward={() => setHistory(historyForward)}
			onClose={onClose}
			onNavigate={(id) => setHistory((h) => historyOpen(h, id))}
			onDepth={setDepth}
			onAction={(action: NodeAction) =>
				void guarded(() => (action === "askInChat" ? askInChat() : post(nodeId, "actions", { action })))
			}
			onGenerate={() =>
				void guarded(async () => {
					setGenerating(true);
					try {
						await post(nodeId, "explanation", { action: "generate" });
					} finally {
						setGenerating(false);
					}
				})
			}
			onCreateCard={(question, answer) =>
				void guarded(() =>
					api("/api/ext/cards", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ nodeId, question, answer }),
					}),
				)
			}
			onSaveEdit={(body) => void guarded(() => post(nodeId, "explanation", { action: "save", body }))}
			onDecide={(decision) =>
				void guarded(() => post(nodeId, "explanation", { action: decision === "approved" ? "approve" : "reject" }))
			}
			onSaveStudyNote={(chatId, text) =>
				void guarded(() => api(`/api/ext/session-notes/${encodeURIComponent(chatId)}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				}))
			}
			onClearStudyNote={(chatId) =>
				void guarded(() => api(`/api/ext/session-notes/${encodeURIComponent(chatId)}`, { method: "DELETE" }))
			}
			renderBody={(markdown) => <MessageResponse>{markdown}</MessageResponse>}
		/>
	);
}
