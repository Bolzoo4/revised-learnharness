"use client";

import { useCallback, useEffect, useState } from "react";

/*
 * The node's research mark, shown in the graph's node detail card (REQ-rs-18).
 * Components import only the core barrel, so these shapes are local mirrors of
 * the marks route (app/api/ext/research/marks). Every failure shows one fixed text.
 */

export interface NodeMark {
	id: string;
	scope: { kind: "node" | "subtree" | "goal"; id: string };
	mark: "expand" | "hold" | "stop";
	author: "user" | "agent";
}

type Fetcher = typeof fetch;
type Choice = NodeMark["mark"];

const GENERIC_ERROR = "Something went wrong. Please try again.";
const CHOICES: ReadonlyArray<{ value: Choice; label: string }> = [
	{ value: "expand", label: "Expand" },
	{ value: "hold", label: "Hold" },
	{ value: "stop", label: "Stop" },
];

/** The marks whose scope is this node (a subtree or goal mark that covers it is not listed). */
export function nodeMarksOf(marks: NodeMark[], nodeId: string): NodeMark[] {
	return marks.filter((m) => m.scope.kind === "node" && m.scope.id === nodeId);
}

async function deleteMark(id: string, fetcher: Fetcher): Promise<boolean> {
	const res = await fetcher("/api/ext/research/marks", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
	return res.ok;
}

/** Sets the node's mark: the new one is written first, and the node's previous marks are cleared only after that succeeded. */
export async function setNodeMark(nodeId: string, mark: Choice, existing: NodeMark[], fetcher: Fetcher = fetch): Promise<boolean> {
	const res = await fetcher("/api/ext/research/marks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: { kind: "node", id: nodeId }, mark }),
	});
	if (!res.ok) return false;
	for (const old of existing) {
		if (!(await deleteMark(old.id, fetcher))) return false;
	}
	return true;
}

/** Clears every mark on the node. */
export async function clearNodeMarks(existing: NodeMark[], fetcher: Fetcher = fetch): Promise<boolean> {
	for (const old of existing) {
		if (!(await deleteMark(old.id, fetcher))) return false;
	}
	return true;
}

export function NodeMarkView(props: {
	current: NodeMark | null;
	busy: boolean;
	error: string | null;
	onSet: (mark: Choice) => void;
	onClear: () => void;
}) {
	const currentText =
		props.current === null ? "none" : `${props.current.mark}, set by ${props.current.author === "user" ? "you" : "research"}`;
	return (
		<div className="mt-2 flex flex-col gap-1 text-xs">
			<div>
				<span className="text-muted-foreground">Research mark: </span>
				<span>Current mark: {currentText}</span>
			</div>
			<div className="flex flex-wrap gap-1">
				{CHOICES.map((c) => (
					<button key={c.value} type="button" disabled={props.busy} onClick={() => props.onSet(c.value)} className="rounded border px-2 py-0.5">
						{c.label}
					</button>
				))}
				<button
					type="button"
					disabled={props.busy || props.current === null}
					onClick={props.onClear}
					className="rounded border px-2 py-0.5"
				>
					Clear
				</button>
			</div>
			{props.error !== null ? <div role="alert" className="text-destructive">{props.error}</div> : null}
		</div>
	);
}

export function NodeMarkControl({ nodeId }: { nodeId: string }) {
	const [marks, setMarks] = useState<NodeMark[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/ext/research/marks");
			if (!res.ok) return setError(GENERIC_ERROR);
			const body = (await res.json()) as { marks: NodeMark[] };
			setMarks(nodeMarksOf(body.marks, nodeId));
		} catch {
			setError(GENERIC_ERROR);
		}
	}, [nodeId]);

	useEffect(() => {
		setError(null);
		void load();
	}, [load]);

	/** Runs one change, shows the fixed text on failure, then reloads this node's marks. */
	const change = useCallback(
		async (work: () => Promise<boolean>) => {
			setBusy(true);
			setError(null);
			try {
				if (!(await work())) setError(GENERIC_ERROR);
			} catch {
				setError(GENERIC_ERROR);
			} finally {
				setBusy(false);
				await load();
			}
		},
		[load],
	);

	return (
		<NodeMarkView
			current={marks[0] ?? null}
			busy={busy}
			error={error}
			onSet={(mark) => void change(() => setNodeMark(nodeId, mark, marks))}
			onClear={() => void change(() => clearNodeMarks(marks))}
		/>
	);
}
