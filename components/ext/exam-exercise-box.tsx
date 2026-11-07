/**
 * The exercise of an exam session, pinned under the chat's top bar so the question stays in view while the
 * conversation scrolls. Collapsible (open by default); a long statement scrolls inside its own box.
 */
export function ExamExerciseBox({ order, pages, text }: { order: number; pages: string; text: string }) {
	return (
		<details open className="shrink-0 border-b bg-muted/30 px-4 py-2 text-sm">
			<summary className="flex cursor-pointer items-baseline justify-between gap-2">
				<span className="font-medium">Exercise {order}</span>
				<span className="text-muted-foreground">{pages}</span>
			</summary>
			<p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap">{text}</p>
		</details>
	);
}
