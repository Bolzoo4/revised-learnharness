"use client";

import { useEffect, useRef, useState } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfJs = typeof import("pdfjs-dist");
type LoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;

let pdfjsPromise: Promise<PdfJs> | null = null;
/** pdf.js is loaded on first use, in the browser only (the module touches DOM globals at load time). */
function loadPdfjs(): Promise<PdfJs> {
	pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
		lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return lib;
	});
	return pdfjsPromise;
}

/**
 * One page of a stored PDF: a canvas for the picture and a transparent text
 * layer above it, so the learner can select text (REQ-study-04, 08). The page
 * is a prop; navigation controls belong to the parent.
 */
export function PdfViewer({ documentId, page, onError }: { documentId: string; page: number; onError?: (message: string) => void }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textRef = useRef<HTMLDivElement>(null);
	const [doc, setDoc] = useState<PdfDocument | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

	// Load the document once per id.
	useEffect(() => {
		let cancelled = false;
		let task: LoadingTask | null = null;
		setDoc(null);
		setStatus("loading");
		void (async () => {
			try {
				const [lib, res] = await Promise.all([loadPdfjs(), fetch(`/api/ext/study/documents/${documentId}/pdf`)]);
				if (!res.ok) throw new Error(`the PDF could not be loaded (${res.status})`);
				const data = new Uint8Array(await res.arrayBuffer());
				task = lib.getDocument({ data });
				const loaded = await task.promise;
				if (!cancelled) setDoc(loaded);
			} catch (e) {
				if (cancelled) return;
				setStatus("failed");
				onError?.(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
			void task?.destroy();
		};
	}, [documentId, onError]);

	// Draw the current page.
	useEffect(() => {
		if (doc === null) return;
		let cancelled = false;
		let cancelRender: (() => void) | null = null;
		void (async () => {
			try {
				const lib = await loadPdfjs();
				const pdfPage = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
				const host = hostRef.current;
				const canvas = canvasRef.current;
				const textLayer = textRef.current;
				if (cancelled || !host || !canvas || !textLayer) return;
				const scale = (host.clientWidth || 800) / pdfPage.getViewport({ scale: 1 }).width;
				const viewport = pdfPage.getViewport({ scale });
				const dpr = window.devicePixelRatio || 1;
				canvas.width = Math.floor(viewport.width * dpr);
				canvas.height = Math.floor(viewport.height * dpr);
				canvas.style.width = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;
				textLayer.replaceChildren();
				textLayer.style.width = `${viewport.width}px`;
				textLayer.style.height = `${viewport.height}px`;
				textLayer.style.setProperty("--total-scale-factor", String(scale));
				const render = pdfPage.render({ canvas, viewport, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) });
				const layer = new lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textLayer, viewport });
				cancelRender = () => {
					render.cancel();
					layer.cancel();
				};
				await Promise.all([render.promise, layer.render()]);
				if (!cancelled) setStatus("ready");
			} catch (e) {
				if (cancelled || (e as { name?: string })?.name === "RenderingCancelledException") return;
				setStatus("failed");
				onError?.(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
			cancelRender?.();
		};
	}, [doc, page, onError]);

	return (
		<div ref={hostRef} data-testid="pdf-viewer" className="relative w-full overflow-auto">
			{status === "loading" ? <p className="p-4 text-sm text-muted-foreground">Loading the document…</p> : null}
			{status === "failed" ? <p className="p-4 text-sm text-destructive">The PDF could not be shown.</p> : null}
			<div className="relative" style={{ display: status === "failed" ? "none" : "block" }}>
				<canvas ref={canvasRef} className="block" />
				<div ref={textRef} className="textLayer" data-testid="pdf-text-layer" />
			</div>
		</div>
	);
}
