// src/core/ext/lecture/lecture.ts
/**
 * The lecture document (child spec 4, REQ-lec-06): what
 * data/ext/lectures/<id>/lecture.json holds. Pure types, a structural parser
 * and the inline node-link markup `[[n_…]]` / `[[n_…|label]]` (the same markup
 * as node explanations). Semantic rules (do the cited nodes exist, is the
 * discourse rephrased...) live in validate.ts.
 */

export const LECTURE_VERSION = 1;

export type SlideElementType = "text" | "formula" | "list";
export interface SlideElement {
	id: string;
	type: SlideElementType;
	/** text / formula: the content (may carry node links). */
	content?: string;
	/** list: one string per item (may carry node links). */
	items?: string[];
}
export interface Slide {
	id: string;
	heading: string;
	elements: SlideElement[];
}

/** narrate: spoken discourse. note: editorial addition (REQ-lec-08), a visually distinct aside.
 *  exercise: timed prompt (`seconds`). reveal: the discussion that must follow an exercise. */
export type BlockRole = "narrate" | "note" | "exercise" | "reveal";
export type CueStyle = "box" | "underline";
/** From character offset `atChar` of the block text on, highlight slide element `target`. */
export interface Cue {
	atChar: number;
	target: string;
	style: CueStyle;
}
export interface Block {
	id: string;
	role: BlockRole;
	slideId: string;
	text: string;
	/** Graph nodes this block covers (a narrate block must cite at least one). */
	nodeIds: string[];
	cues: Cue[];
	/** exercise only: thinking time. */
	seconds?: number;
}

export interface Lecture {
	version: typeof LECTURE_VERSION;
	id: string;
	bookId: string;
	bookTitle: string;
	chapter: { index: number; title: string; pageStart: number; pageEnd: number };
	/** 1-based position of this lecture inside its chapter. */
	order: number;
	title: string;
	/** 3-4 sentence recap handed to the next lecture of the chapter. */
	summary: string;
	/** The notes-source id (src_…) the chapter graph was extracted under. */
	chapterSourceId: string;
	createdAt: string;
	slides: Slide[];
	blocks: Block[];
}

const LECTURE_ID_RE = /^lec_b[0-9a-f]{8}_c\d{2,3}_l\d{2,3}$/;
export function isValidLectureId(id: unknown): id is string {
	return typeof id === "string" && LECTURE_ID_RE.test(id);
}
const pad = (n: number): string => String(n).padStart(2, "0");
export function lectureId(bookId: string, chapterIndex: number, order: number): string {
	return `lec_${bookId}_c${pad(chapterIndex)}_l${pad(order)}`;
}

// ── structural parser ───────────────────────────────────────────────────────

const ELEMENT_TYPES = new Set<string>(["text", "formula", "list"]);
const ROLES = new Set<string>(["narrate", "note", "exercise", "reveal"]);
const STYLES = new Set<string>(["box", "underline"]);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function parseElement(raw: unknown): SlideElement | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.type) || !ELEMENT_TYPES.has(raw.type)) return null;
	if (raw.type === "list") {
		if (!Array.isArray(raw.items) || !raw.items.every(isStr)) return null;
		return { id: raw.id, type: "list", items: [...raw.items] };
	}
	if (!isStr(raw.content)) return null;
	return { id: raw.id, type: raw.type as SlideElementType, content: raw.content };
}

function parseSlide(raw: unknown): Slide | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.heading) || !Array.isArray(raw.elements)) return null;
	const elements: SlideElement[] = [];
	for (const e of raw.elements) {
		const parsed = parseElement(e);
		if (parsed === null) return null;
		elements.push(parsed);
	}
	return { id: raw.id, heading: raw.heading, elements };
}

function parseBlock(raw: unknown): Block | null {
	if (!isObj(raw) || !isNonEmpty(raw.id) || !isStr(raw.role) || !ROLES.has(raw.role)) return null;
	if (!isNonEmpty(raw.slideId) || !isNonEmpty(raw.text)) return null;
	if (!Array.isArray(raw.nodeIds) || !raw.nodeIds.every(isNonEmpty)) return null;
	if (!Array.isArray(raw.cues)) return null;
	const cues: Cue[] = [];
	for (const c of raw.cues) {
		if (!isObj(c) || !isInt(c.atChar) || c.atChar < 0 || !isNonEmpty(c.target) || !isStr(c.style) || !STYLES.has(c.style)) return null;
		cues.push({ atChar: c.atChar, target: c.target, style: c.style as CueStyle });
	}
	const block: Block = { id: raw.id, role: raw.role as BlockRole, slideId: raw.slideId, text: raw.text, nodeIds: [...raw.nodeIds], cues };
	if (raw.role === "exercise") {
		if (!isInt(raw.seconds) || raw.seconds <= 0) return null;
		block.seconds = raw.seconds;
	}
	return block;
}

/** Structural check only. null = not a lecture this build understands. */
export function parseLecture(raw: unknown): Lecture | null {
	if (!isObj(raw) || raw.version !== LECTURE_VERSION || !isValidLectureId(raw.id)) return null;
	if (!isNonEmpty(raw.bookId) || !isStr(raw.bookTitle) || !isNonEmpty(raw.title) || !isStr(raw.summary)) return null;
	if (!isNonEmpty(raw.chapterSourceId) || !isNonEmpty(raw.createdAt) || !isInt(raw.order) || raw.order < 1) return null;
	const ch = raw.chapter;
	if (!isObj(ch) || !isInt(ch.index) || !isStr(ch.title) || !isInt(ch.pageStart) || !isInt(ch.pageEnd)) return null;
	if (!Array.isArray(raw.slides) || !Array.isArray(raw.blocks)) return null;
	const slides: Slide[] = [];
	for (const s of raw.slides) {
		const parsed = parseSlide(s);
		if (parsed === null) return null;
		slides.push(parsed);
	}
	const blocks: Block[] = [];
	for (const b of raw.blocks) {
		const parsed = parseBlock(b);
		if (parsed === null) return null;
		blocks.push(parsed);
	}
	return {
		version: LECTURE_VERSION,
		id: raw.id,
		bookId: raw.bookId,
		bookTitle: raw.bookTitle,
		chapter: { index: ch.index, title: ch.title, pageStart: ch.pageStart, pageEnd: ch.pageEnd },
		order: raw.order,
		title: raw.title,
		summary: raw.summary,
		chapterSourceId: raw.chapterSourceId,
		createdAt: raw.createdAt,
		slides,
		blocks,
	};
}

// ── inline node links ───────────────────────────────────────────────────────

const NODE_LINK_RE = /\[\[(n_[A-Za-z0-9_-]+)(?:\|([^\]]*))?\]\]/g;

export type TextPart = { kind: "text"; text: string } | { kind: "node"; nodeId: string; label: string | null };

/** Split text into plain parts and node links, in order. Never loses text. */
export function parseNodeLinks(text: string): TextPart[] {
	const parts: TextPart[] = [];
	let last = 0;
	for (const m of text.matchAll(NODE_LINK_RE)) {
		const at = m.index ?? 0;
		if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
		const label = m[2];
		parts.push({ kind: "node", nodeId: m[1]!, label: label === undefined || label === "" ? null : label });
		last = at + m[0].length;
	}
	if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
	return parts;
}

/** Node ids linked inside one text, in order of appearance, without repeats. */
export function textNodeRefs(text: string): string[] {
	const out: string[] = [];
	for (const p of parseNodeLinks(text)) if (p.kind === "node" && !out.includes(p.nodeId)) out.push(p.nodeId);
	return out;
}

/** Strip the link markup, keeping the visible words (for narration and verbatim checks). */
export function stripNodeLinks(text: string): string {
	return parseNodeLinks(text)
		.map((p) => (p.kind === "text" ? p.text : (p.label ?? p.nodeId)))
		.join("");
}

function slideTexts(slide: Slide): string[] {
	return slide.elements.flatMap((e) => (e.type === "list" ? (e.items ?? []) : [e.content ?? ""]));
}

/** Every node id the lecture cites: block citations and slide links, first appearance order, no repeats. */
export function lectureNodeRefs(lecture: Lecture): string[] {
	const out: string[] = [];
	const add = (id: string): void => {
		if (!out.includes(id)) out.push(id);
	};
	for (const b of lecture.blocks) for (const id of b.nodeIds) add(id);
	for (const s of lecture.slides) for (const t of slideTexts(s)) for (const id of textNodeRefs(t)) add(id);
	return out;
}

/** All slide texts of a lecture (used by the validator for link checks). */
export function lectureSlideTexts(lecture: Lecture): string[] {
	return lecture.slides.flatMap(slideTexts);
}
