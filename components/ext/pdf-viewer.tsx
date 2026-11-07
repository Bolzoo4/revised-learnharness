"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderWindow, stackPages, visiblePages, type PageRect, type VisiblePages, type Viewport } from "./study-logic";

type PdfJs = typeof import("pdfjs-dist");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfPage = import("pdfjs-dist").PDFPageProxy;
type LoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;

/** The only failure text the viewer shows: pdf.js and server messages are never displayed. */
export const SHOWN_FAILED = "The PDF could not be shown.";

/** Space between pages, and around the first and last one (px). */
const GAP = 12;
/** Pages kept rendered beyond the ones on screen. */
const RENDER_MARGIN = 2;
/** A width change redraws the canvases only after the width has been still this long (a divider drag would redraw every frame otherwise). */
const REDRAW_DELAY_MS = 150;

let pdfjsPromise: Promise<PdfJs> | null = null;
/** pdf.js is loaded on first use, in the browser only (the module touches DOM globals at load time). */
function loadPdfjs(): Promise<PdfJs> {
	pdfjsPromise ??= import("pdfjs-dist").then((lib) => {
		// The worker is resolved by the bundler from node_modules. This must be verified in a browser:
		// the request for pdf.worker.min.mjs has to return 200, or every page fails to render.
		lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return lib;
	});
	return pdfjsPromise;
}

export interface PdfViewerProps {
	documentId: string;
	/** A scroll request: the page whose top is brought into view. A new object scrolls again. */
	jump: { page: number; nonce: number };
	/** Zoom as a multiple of fit-to-width. */
	zoom: number;
	/** The pages on screen, reported after each scroll and layout change. */
	onVisible?: (pages: VisiblePages) => void;
	onError?: (message: string) => void;
}

/**
 * The whole document as one scrollable column (REQ-study-04, 08). Every page
 * has a box of the right height, so the column is as long as the book; only the
 * pages near the viewport are drawn (canvas plus a text layer, so the text can
 * be selected). A page drawn for the first time reports its own aspect ratio,
 * and the boxes below the anchor are corrected without moving what is on screen.
 */
export function PdfViewer({ documentId, jump, zoom, onVisible, onError }: PdfViewerProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [doc, setDoc] = useState<PdfDocument | null>(null);
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
	/** Width of the scroll area in px (0 until measured). */
	const [width, setWidth] = useState(0);
	/** Height over width of every page; page 1's ratio until a page is drawn. */
	const [ratios, setRatios] = useState<number[]>([]);
	const [view, setView] = useState<Viewport>({ top: 0, height: 0 });
	const onVisibleRef = useRef(onVisible);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onVisibleRef.current = onVisible;
		onErrorRef.current = onError;
	});

	/** The width a page is laid out at now. */
	const pageWidth = Math.max(0, width - 2 * GAP) * zoom;
	/** The width pages are drawn at: lags a moment behind pageWidth so a continuous resize draws once. */
	const [drawWidth, setDrawWidth] = useState(0);
	useEffect(() => {
		const t = setTimeout(() => setDrawWidth(pageWidth), REDRAW_DELAY_MS);
		return () => clearTimeout(t);
	}, [pageWidth]);

	const layout = useMemo(() => stackPages(ratios, pageWidth, GAP), [ratios, pageWidth]);
	const layoutRef = useRef(layout);
	useLayoutEffect(() => {
		layoutRef.current = layout;
	}, [layout]);
	const contentWidth = Math.max(width, pageWidth + 2 * GAP);
	const pageLeft = (contentWidth - pageWidth) / 2;

	// The page the learner is anchored to: its position on screen survives a re-layout (a corrected height, a zoom, a resize).
	const anchorRef = useRef<{ page: number; fraction: number } | null>(null);

	const measure = useCallback(() => {
		const el = scrollRef.current;
		const lay = layoutRef.current;
		if (!el) return;
		const v: Viewport = { top: el.scrollTop, height: el.clientHeight };
		setView(v);
		const rects: PageRect[] = lay.tops.map((top, i) => ({ page: i + 1, top, height: lay.heights[i]! }));
		const visible = visiblePages(rects, v);
		if (visible.primary !== null) {
			const i = visible.primary - 1;
			const h = lay.heights[i]!;
			if (h > 0) anchorRef.current = { page: visible.primary, fraction: (v.top - lay.tops[i]!) / h };
		}
		onVisibleRef.current?.(visible);
	}, []);

	const frame = useRef(0);
	const onScroll = useCallback(() => {
		if (frame.current !== 0) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			measure();
		});
	}, [measure]);
	useEffect(() => () => {
		if (frame.current !== 0) cancelAnimationFrame(frame.current);
	}, []);

	// Measure the scroll area's width.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => setWidth(el.clientWidth);
		update();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Keep the anchored page where it is on screen when the layout changes.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		const a = anchorRef.current;
		if (!el || a === null || a.page > layout.tops.length) return;
		const target = layout.tops[a.page - 1]! + a.fraction * layout.heights[a.page - 1]!;
		if (Math.abs(el.scrollTop - target) > 0.5) el.scrollTop = target;
		measure();
	}, [layout, measure]);

	// Load the document once per id; page 1 gives the placeholder shape of every page.
	useEffect(() => {
		let cancelled = false;
		let task: LoadingTask | null = null;
		let loaded: PdfDocument | null = null;
		setDoc(null);
		setStatus("loading");
		setRatios([]);
		void (async () => {
			try {
				const [lib, res] = await Promise.all([loadPdfjs(), fetch(`/api/ext/study/documents/${encodeURIComponent(documentId)}/pdf`)]);
				if (cancelled) return;
				if (!res.ok) throw new Error(`the PDF could not be loaded (${res.status})`);
				const data = new Uint8Array(await res.arrayBuffer());
				if (cancelled) return;
				task = lib.getDocument({ data });
				loaded = await task.promise;
				if (cancelled) {
					void task.destroy(); // the view moved on while the document was loading: destroying the task frees the document too
					return;
				}
				const first = await loaded.getPage(1);
				const size = first.getViewport({ scale: 1 });
				first.cleanup();
				if (cancelled) return;
				setRatios(Array.from({ length: loaded.numPages }, () => size.height / size.width));
				setDoc(loaded);
				setStatus("ready");
			} catch {
				if (cancelled) return;
				setStatus("failed");
				onErrorRef.current?.(SHOWN_FAILED);
			}
		})();
		return () => {
			cancelled = true;
			void task?.destroy();
		};
	}, [documentId]);

	// A jump request waits until the layout exists, then scrolls once.
	const pendingJump = useRef<{ page: number; nonce: number } | null>(null);
	useEffect(() => {
		pendingJump.current = jump;
	}, [jump]);
	useEffect(() => {
		const el = scrollRef.current;
		const want = pendingJump.current;
		if (!el || want === null || status !== "ready" || pageWidth <= 0 || layoutRef.current.tops.length === 0) return;
		pendingJump.current = null;
		const i = Math.min(Math.max(1, want.page), layoutRef.current.tops.length) - 1;
		el.scrollTop = layoutRef.current.tops[i]! - GAP;
		measure();
	}, [jump, status, pageWidth, measure]);

	const onRatio = useCallback((page: number, ratio: number) => {
		setRatios((prev) => {
			if (prev[page - 1] === undefined || Math.abs(prev[page - 1]! - ratio) < 1e-6) return prev;
			const next = prev.slice();
			next[page - 1] = ratio;
			return next;
		});
	}, []);

	const rects: PageRect[] = layout.tops.map((top, i) => ({ page: i + 1, top, height: layout.heights[i]! }));
	const win = renderWindow(rects, view, RENDER_MARGIN);
	const pageNumbers = Array.from({ length: ratios.length }, (_, i) => i + 1);

	return (
		<div
			ref={scrollRef}
			role="region"
			aria-label="Document pages"
			tabIndex={0}
			onScroll={onScroll}
			data-testid="pdf-viewer"
			className="relative min-h-0 flex-1 overflow-auto bg-muted/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
		>
			{status === "loading" ? <p className="p-4 text-sm text-muted-foreground">Loading the document…</p> : null}
			{status === "failed" ? <p className="p-4 text-sm text-destructive">{SHOWN_FAILED}</p> : null}
			{status === "ready" && doc !== null ? (
				<div className="relative mx-auto" style={{ height: layout.total, width: contentWidth }}>
					{pageNumbers.map((page) => {
						const i = page - 1;
						const drawn = win !== null && page >= win.first && page <= win.last;
						return (
							<div
								key={page}
								data-page-number={page}
								className="absolute overflow-hidden bg-white shadow-sm"
								style={{ top: layout.tops[i], left: pageLeft, width: pageWidth, height: layout.heights[i] }}
							>
								{drawn && drawWidth > 0 ? <PdfPageCanvas doc={doc} page={page} width={drawWidth} onRatio={onRatio} onError={(m) => onErrorRef.current?.(m)} /> : null}
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

/**
 * One page drawn at `width` px: a canvas for the picture and a transparent text
 * layer above it. Unmounting cancels the drawing and frees the canvas.
 */
function PdfPageCanvas({ doc, page, width, onRatio, onError }: { doc: PdfDocument; page: number; width: number; onRatio: (page: number, ratio: number) => void; onError: (message: string) => void }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const textRef = useRef<HTMLDivElement>(null);
	const onErrorRef = useRef(onError);
	const onRatioRef = useRef(onRatio);
	useEffect(() => {
		onErrorRef.current = onError;
		onRatioRef.current = onRatio;
	});

	useEffect(() => {
		const canvas = canvasRef.current;
		const textLayer = textRef.current;
		if (!canvas || !textLayer) return;
		let cancelled = false;
		let drawn: PdfPage | null = null;
		let cancelRender: (() => void) | null = null;
		void (async () => {
			const lib = await loadPdfjs();
			drawn = await doc.getPage(page);
			const pdfPage = drawn;
			if (cancelled) return;
			const base = pdfPage.getViewport({ scale: 1 });
			onRatioRef.current(page, base.height / base.width);
			const scale = width / base.width;
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
		})().catch((e: unknown) => {
			if (cancelled || (e as { name?: string })?.name === "RenderingCancelledException") return;
			onErrorRef.current(SHOWN_FAILED);
		});
		return () => {
			cancelled = true;
			cancelRender?.();
			drawn?.cleanup(); // releases the page's cached resources; pdf.js defers it while a render is still running
			canvas.width = 0; // frees the bitmap of a page that left the window
			canvas.height = 0;
		};
	}, [doc, page, width]);

	return (
		<div className="relative h-full w-full">
			<canvas ref={canvasRef} className="block" />
			<div ref={textRef} className="textLayer" data-testid="pdf-text-layer" />
		</div>
	);
}
