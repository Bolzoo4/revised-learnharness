// components/ext/node-panel-host.tsx
"use client";

import { useEffect, useState } from "react";
import { NodePanel, type PanelRequest } from "./node-panel";
import { OPEN_NODE_EVENT } from "./open-node";

/** Width reserved on the right; the page content keeps working beside it (REQ-node-11). */
const PANEL_WIDTH_PX = 416;

export function NodePanelHost() {
	const [request, setRequest] = useState<PanelRequest | null>(null);
	const open = request !== null;

	useEffect(() => {
		const onOpen = (event: Event) => {
			const nodeId = (event as CustomEvent<{ nodeId?: unknown }>).detail?.nodeId;
			if (typeof nodeId === "string" && nodeId !== "") {
				setRequest((prev) => ({ nodeId, seq: (prev?.seq ?? 0) + 1 }));
			}
		};
		window.addEventListener(OPEN_NODE_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_NODE_EVENT, onOpen);
	}, []);

	// Make room instead of covering the current view.
	useEffect(() => {
		if (!open) return;
		const before = document.body.style.paddingRight;
		document.body.style.paddingRight = `${PANEL_WIDTH_PX}px`;
		return () => {
			document.body.style.paddingRight = before;
		};
	}, [open]);

	if (request === null) return null;
	return (
		<aside
			data-testid="node-panel"
			className="lh-no-drag fixed right-0 top-0 z-30 h-dvh overflow-y-auto border-l bg-background"
			style={{ width: PANEL_WIDTH_PX }}
		>
			<NodePanel request={request} onClose={() => setRequest(null)} />
		</aside>
	);
}
