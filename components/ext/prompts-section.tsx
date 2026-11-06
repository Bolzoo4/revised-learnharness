"use client";
/**
 * "Extension agents" in the Agent settings: the extension's own agent prompts,
 * each editable with the same semantics as upstream's "System prompts"
 * (docs/ext/CONTRACTS.md, "Editable extension prompts"):
 *   - the user's version is in use only while its switch is on and its file exists;
 *   - "Reset to default" removes the file and clears the switch;
 *   - the default text is always one click away;
 *   - a new agent run reads the current text (the agent layer reads fresh per construction).
 * Mounted once, in components/settings/agent-section.tsx, after upstream's System prompts group.
 */

import { useCallback, useEffect, useState } from "react";
import type { ExtPromptView } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "../settings/controls.tsx";

/** The text the editor shows and whether Save has something to save. */
export function promptEditorState(prompt: ExtPromptView, draft: string | null): { shown: string; dirty: boolean; hasFile: boolean } {
	const saved = prompt.overrideText ?? prompt.defaultText;
	const shown = draft ?? saved;
	return { shown, dirty: draft !== null && draft !== saved, hasFile: prompt.overrideText !== null };
}

/** The quiet line that says which version is in use. */
export function promptUseHint(prompt: ExtPromptView): string | undefined {
	if (prompt.enabled) return "Your version is in use";
	if (prompt.overrideText !== null) return "Your version is saved but not in use";
	return undefined;
}

/** The error text of a failed request: the server's fixed message, or a generic one. */
async function failureText(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
}

/** One agent's row: switch, description, warning, default text, editor, and the save and reset actions. */
export function ExtPromptRow({ prompt, onChanged }: { prompt: ExtPromptView; onChanged: () => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	const [showDefault, setShowDefault] = useState(false);
	const [busy, setBusy] = useState<"save" | "reset" | "switch" | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const { shown, dirty, hasFile } = promptEditorState(prompt, draft);
	const id = prompt.id;

	/** One write; on success the parent re-reads the list, on failure the reason is shown. */
	async function send(kind: "save" | "reset" | "switch", request: Promise<Response>, done: string) {
		setBusy(kind);
		setStatus(null);
		try {
			const res = await request;
			if (!res.ok) {
				setStatus(`${done} failed: ${await failureText(res)}`);
				return;
			}
			setDraft(null);
			setStatus(done);
			onChanged();
		} catch {
			setStatus(`${done} failed: the server did not answer`);
		} finally {
			setBusy(null);
		}
	}

	const url = `/api/ext/prompts/${encodeURIComponent(id)}`;
	const hint = promptUseHint(prompt);

	return (
		<div data-testid={`ext-prompt-${id}`} className="flex flex-col gap-2">
			<SettingsRow
				label={prompt.label}
				hint={[prompt.description, hint].filter(Boolean).join(" · ")}
				testid={`ext-prompt-row-${id}`}
			>
				<span className={hasFile ? "flex items-center gap-2" : "flex items-center gap-2 opacity-40"}>
					<span className="text-xs text-muted-foreground">Use my version</span>
					<Toggle
						checked={prompt.enabled}
						disabled={!hasFile || busy !== null}
						label={`ext prompt ${id}`}
						onChange={(on) =>
							void send(
								"switch",
								fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: on }) }),
								on ? "Your version is in use" : "The default is in use",
							)
						}
					/>
				</span>
			</SettingsRow>
			<p className="text-xs text-muted-foreground/70" data-testid={`ext-prompt-warning-${id}`}>
				{prompt.warning}
			</p>
			<button
				type="button"
				onClick={() => setShowDefault(!showDefault)}
				className="self-start text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
			>
				{showDefault ? "Hide default text" : "Show default text"}
			</button>
			{showDefault && (
				<textarea
					readOnly
					value={prompt.defaultText}
					aria-label={`The default instructions of ${prompt.label}`}
					className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
				/>
			)}
			<textarea
				value={shown}
				onChange={(e) => setDraft(e.target.value)}
				aria-label={`Your version of ${prompt.label}`}
				placeholder="Write your own instructions…"
				className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
			/>
			<div className="flex items-center gap-3">
				<button
					type="button"
					data-testid={`ext-prompt-save-${id}`}
					disabled={!dirty || busy !== null}
					onClick={() =>
						void send(
							"save",
							fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: shown, enabled: true }) }),
							"Saved",
						)
					}
					className={
						dirty && busy === null
							? "text-xs text-foreground underline-offset-2 hover:underline"
							: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
					}
				>
					{busy === "save" ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					data-testid={`ext-prompt-reset-${id}`}
					disabled={!hasFile || busy !== null}
					onClick={() => void send("reset", fetch(url, { method: "DELETE" }), "Reset to default")}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
				>
					{busy === "reset" ? "Resetting…" : "Reset to default"}
				</button>
				{status && (
					<p role="status" className="text-xs text-muted-foreground/70" data-testid={`ext-prompt-status-${id}`}>
						{status}
					</p>
				)}
			</div>
		</div>
	);
}

/** The "Extension agents" group: one row per editable extension prompt. */
export function ExtPromptsSection() {
	const [prompts, setPrompts] = useState<ExtPromptView[] | null>(null);
	const [failed, setFailed] = useState(false);

	const load = useCallback(() => {
		fetch("/api/ext/prompts")
			.then((res) => {
				if (!res.ok) throw new Error(String(res.status));
				return res.json() as Promise<ExtPromptView[]>;
			})
			.then((body) => {
				setPrompts(body);
				setFailed(false);
			})
			.catch(() => setFailed(true));
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<SettingsGroup label="Extension agents" testid="group-ext-prompts">
			{failed ? (
				<p role="alert" className="text-xs text-red-400">
					The extension agents could not be loaded. <button type="button" className="underline" onClick={load}>Retry</button>
				</p>
			) : prompts === null ? (
				<p className="text-xs text-muted-foreground/70">Loading extension agents…</p>
			) : (
				<div className="flex flex-col gap-4">
					{prompts.map((prompt) => (
						<ExtPromptRow key={prompt.id} prompt={prompt} onChanged={load} />
					))}
				</div>
			)}
		</SettingsGroup>
	);
}
