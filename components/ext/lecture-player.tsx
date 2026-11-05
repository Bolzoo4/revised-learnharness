"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activeCue, parseNodeLinks, type Lecture, type LectureBlock, type LectureSlideElement } from "@/src/core";

const ROLE_LABEL: Record<LectureBlock["role"], string> = { narrate: "", note: "Note", exercise: "Exercise", reveal: "Discussion" };

function Linked({ text, onNodeClick }: { text: string; onNodeClick?: (nodeId: string) => void }) {
	return (
		<>
			{parseNodeLinks(text).map((p, i) =>
				p.kind === "text" ? (
					<span key={i}>{p.text}</span>
				) : (
					<button key={i} type="button" className="underline decoration-dotted" onClick={() => onNodeClick?.(p.nodeId)}>
						{p.label ?? p.nodeId}
					</button>
				),
			)}
		</>
	);
}

function Element({ el, cue, onNodeClick }: { el: LectureSlideElement; cue: "box" | "underline" | null; onNodeClick?: (id: string) => void }) {
	const mark = cue === "box" ? "outline outline-2 outline-offset-2 outline-primary" : cue === "underline" ? "underline decoration-2" : "";
	if (el.type === "list") {
		return (
			<ul className={`list-disc pl-5 ${mark}`}>
				{(el.items ?? []).map((item, i) => (
					<li key={i}><Linked text={item} onNodeClick={onNodeClick} /></li>
				))}
			</ul>
		);
	}
	if (el.type === "formula") return <pre className={`overflow-x-auto font-mono text-sm ${mark}`}>{el.content}</pre>;
	return <p className={mark}><Linked text={el.content ?? ""} onNodeClick={onNodeClick} /></p>;
}

/** Narrated lecture player (REQ-lec-09, 10). Speech: the browser's speechSynthesis; without it the lecture runs in text mode with a manual Next. */
export function LecturePlayer({ lecture, onNodeClick }: { lecture: Lecture; onNodeClick?: (nodeId: string) => void }) {
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [charIndex, setCharIndex] = useState(0);
	const [remaining, setRemaining] = useState<number | null>(null);
	const [hasSpeech, setHasSpeech] = useState(false);
	useEffect(() => setHasSpeech(typeof window !== "undefined" && "speechSynthesis" in window), []);

	const block = lecture.blocks[index];
	const last = index >= lecture.blocks.length - 1;
	const slide = lecture.slides.find((s) => s.id === block?.slideId) ?? lecture.slides[0];
	const cue = block ? activeCue(block.cues, charIndex) : null;

	const goto = useCallback((i: number) => {
		window.speechSynthesis?.cancel();
		setCharIndex(0);
		setRemaining(null);
		setIndex(Math.max(0, Math.min(i, lecture.blocks.length - 1)));
	}, [lecture.blocks.length]);

	const advance = useCallback(() => {
		if (last) setPlaying(false);
		else goto(index + 1);
	}, [goto, index, last]);
	const advanceRef = useRef(advance);
	advanceRef.current = advance;

	// Speak the current block while playing; an exercise then runs its countdown.
	useEffect(() => {
		if (!playing || !block) return;
		const afterSpeech = () => {
			if (block.role === "exercise") setRemaining(block.seconds ?? 60);
			else if (hasSpeech) advanceRef.current();
		};
		if (!hasSpeech) {
			afterSpeech();
			return;
		}
		const u = new SpeechSynthesisUtterance(block.text);
		u.onboundary = (e) => setCharIndex(e.charIndex);
		u.onend = afterSpeech;
		window.speechSynthesis.cancel();
		window.speechSynthesis.speak(u);
		return () => {
			u.onend = null;
			window.speechSynthesis.cancel();
		};
	}, [playing, block, hasSpeech]);

	// The exercise countdown (REQ-lec-10): at zero the lecture moves on to the discussion.
	useEffect(() => {
		if (remaining === null || !playing) return;
		if (remaining <= 0) {
			advanceRef.current();
			return;
		}
		const t = setTimeout(() => setRemaining((r) => (r === null ? r : r - 1)), 1000);
		return () => clearTimeout(t);
	}, [remaining, playing]);

	if (!block || !slide) return <p>This lecture is empty.</p>;
	return (
		<div className="grid gap-4 md:grid-cols-2">
			<section aria-label="Slide" className="flex flex-col gap-3 rounded border p-4">
				<h2 className="text-lg font-medium">{slide.heading}</h2>
				{slide.elements.map((el) => (
					<Element key={el.id} el={el} cue={cue && cue.target === el.id ? cue.style : null} onNodeClick={onNodeClick} />
				))}
			</section>
			<section aria-label="Narration" className="flex flex-col gap-3 rounded border p-4">
				<div className="text-xs text-muted-foreground">
					Block {index + 1} of {lecture.blocks.length}
					{ROLE_LABEL[block.role] ? ` · ${ROLE_LABEL[block.role]}` : ""}
					{!hasSpeech ? " · text mode (no speech engine)" : ""}
				</div>
				<p className={block.role === "note" ? "italic" : ""}>{block.text}</p>
				{remaining !== null ? (
					<div role="timer" className="font-mono text-2xl">{remaining}s</div>
				) : null}
				<div className="mt-auto flex gap-2">
					<button type="button" className="rounded border px-3 py-1" disabled={index === 0} onClick={() => goto(index - 1)}>Previous</button>
					<button type="button" className="rounded border px-3 py-1" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
					<button type="button" className="rounded border px-3 py-1" disabled={last} onClick={() => goto(index + 1)}>{remaining !== null ? "Done" : "Next"}</button>
				</div>
			</section>
		</div>
	);
}
