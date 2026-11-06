"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activeCue, charIndexAtTime, parseNodeLinks, type AudioBlock, type Lecture, type LectureBlock, type LectureSlideElement } from "@/src/core";
import { exerciseDoneAtZero, exerciseDoneOnLeave } from "./lecture-exercise";
import { audioUrl, canGenerate, fetchAudioState, generateBlockAudio, readyBlocks } from "./lecture-audio-client";

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

/** What the session debrief wants to know (REQ-deb-03 lecture facts). */
export interface LectureProgress {
	slide(slideId: string): void;
	exercise(blockId: string): void;
}

/**
 * Narrated lecture player (REQ-lec-09, 10). Each block is spoken by its narration audio (Deepgram, pre-generated
 * or generated on demand, see lecture-audio-client.ts) and highlighted through the audio clock; without audio
 * for it, by the browser's speechSynthesis; without that too, text mode with a manual Next. The next block's audio
 * is requested while the current one plays.
 */
export function LecturePlayer({ lecture, onNodeClick, onProgress }: { lecture: Lecture; onNodeClick?: (nodeId: string) => void; onProgress?: LectureProgress }) {
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [charIndex, setCharIndex] = useState(0);
	const [remaining, setRemaining] = useState<number | null>(null);
	const [hasSpeech, setHasSpeech] = useState(false);
	const [ready, setReady] = useState<Record<string, AudioBlock>>({});
	const [canGen, setCanGen] = useState(false);
	const [preparing, setPreparing] = useState<string | null>(null);
	useEffect(() => setHasSpeech(typeof window !== "undefined" && "speechSynthesis" in window), []);

	// The refs are read by the playback effect, so a finished request never restarts a block that plays.
	const readyRef = useRef(ready);
	readyRef.current = ready;
	const canGenRef = useRef(canGen);
	canGenRef.current = canGen;

	useEffect(() => {
		let alive = true;
		void fetchAudioState(lecture.id).then((state) => {
			if (!alive || state === null) return;
			setCanGen(canGenerate(state));
			setReady((prev) => ({ ...readyBlocks(state.manifest), ...prev }));
		});
		return () => {
			alive = false;
		};
	}, [lecture.id]);

	const block = lecture.blocks[index];
	const last = index >= lecture.blocks.length - 1;
	const slide = lecture.slides.find((s) => s.id === block?.slideId) ?? lecture.slides[0];
	const cue = block ? activeCue(block.cues, charIndex) : null;

	// A slide counts as viewed when it is shown.
	const slideId = slide?.id;
	useEffect(() => {
		if (slideId) onProgress?.slide(slideId);
	}, [slideId, onProgress]);

	/** The ready audio of a block: the known one, or generated on demand when a key exists. Null when there is none. */
	const obtain = useCallback(
		async (blockId: string): Promise<AudioBlock | null> => {
			const known = readyRef.current[blockId];
			if (known !== undefined) return known;
			if (!canGenRef.current) return null;
			const made = await generateBlockAudio(lecture.id, blockId);
			if (made !== null) setReady((prev) => ({ ...prev, [made.blockId]: made }));
			return made;
		},
		[lecture.id],
	);

	const goto = useCallback((i: number) => {
		const target = Math.max(0, Math.min(i, lecture.blocks.length - 1));
		// "Done" (or Next) while the countdown runs counts as doing the exercise; a countdown that reached zero was recorded when it ended.
		const done = exerciseDoneOnLeave(block, remaining, index, target);
		if (done !== null) onProgress?.exercise(done);
		window.speechSynthesis?.cancel();
		setCharIndex(0);
		setRemaining(null);
		setIndex(target);
	}, [lecture.blocks.length, block, remaining, index, onProgress]);

	const advance = useCallback(() => {
		if (last) {
			setPlaying(false);
			setRemaining(null); // a finished last block must not replay its countdown when Play is pressed again
		} else goto(index + 1);
	}, [goto, index, last]);
	const advanceRef = useRef(advance);
	advanceRef.current = advance;

	// Speak the current block while playing; an exercise then runs its countdown. Cleanup stops whatever plays.
	useEffect(() => {
		if (!playing || !block) return;
		let cancelled = false;
		let stop: () => void = () => {};
		// Audio always moves on when it ends; the browser voice moves on only where a speech engine exists (text mode waits for Next).
		const finish = (advanceAfter: boolean) => {
			if (cancelled) return;
			if (block.role === "exercise") setRemaining(block.seconds ?? 60);
			else if (advanceAfter) advanceRef.current();
		};
		const speak = () => {
			if (!hasSpeech) {
				finish(false);
				return;
			}
			const u = new SpeechSynthesisUtterance(block.text);
			u.onboundary = (e) => setCharIndex(e.charIndex);
			u.onend = () => finish(true);
			window.speechSynthesis.cancel();
			window.speechSynthesis.speak(u);
			stop = () => {
				u.onend = null;
				window.speechSynthesis.cancel();
			};
		};
		const playAudio = (entry: AudioBlock) => {
			const el = new Audio(audioUrl(lecture.id, block.id));
			const stopAudio = () => {
				el.onended = null;
				el.onerror = null;
				el.ontimeupdate = null;
				el.pause();
				el.removeAttribute("src");
				el.load();
			};
			const fallBack = () => {
				if (cancelled) return;
				stopAudio();
				stop = () => {};
				speak();
			};
			el.ontimeupdate = () => {
				if (!cancelled) setCharIndex(charIndexAtTime(entry, el.currentTime));
			};
			el.onended = () => finish(true);
			el.onerror = fallBack;
			stop = stopAudio;
			el.play().catch(fallBack);
		};

		const known = readyRef.current[block.id];
		if (known !== undefined) playAudio(known);
		else if (canGenRef.current) {
			setPreparing(block.id);
			void obtain(block.id).then((entry) => {
				if (cancelled) return;
				setPreparing(null);
				if (entry !== null) playAudio(entry);
				else speak();
			});
		} else speak();

		return () => {
			cancelled = true;
			stop();
			setPreparing(null);
		};
	}, [playing, block, hasSpeech, lecture.id, obtain]);

	// While a block plays, the next one's audio is requested, so the next block starts without a wait.
	useEffect(() => {
		if (!playing || !canGen) return;
		const next = lecture.blocks[index + 1];
		if (next !== undefined && ready[next.id] === undefined) void obtain(next.id);
	}, [playing, canGen, index, lecture.blocks, obtain, ready]);

	// The exercise countdown (REQ-lec-10): at zero the exercise is recorded as done and the lecture moves on (on the last block it stops).
	useEffect(() => {
		if (remaining === null || !playing) return;
		if (remaining <= 0) {
			const done = exerciseDoneAtZero(block, remaining);
			if (done !== null) onProgress?.exercise(done);
			advanceRef.current();
			return;
		}
		const t = setTimeout(() => setRemaining((r) => (r === null ? r : r - 1)), 1000);
		return () => clearTimeout(t);
	}, [remaining, playing, block, onProgress]);

	if (!block || !slide) return <p>This lecture is empty.</p>;
	const hasAudio = ready[block.id] !== undefined;
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
					{!hasSpeech && !hasAudio && !canGen ? " · text mode (no speech engine)" : ""}
				</div>
				{preparing === block.id ? <p role="status" className="text-xs text-muted-foreground">Preparing audio…</p> : null}
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
