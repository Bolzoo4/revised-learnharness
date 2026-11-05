// src/agent/ext/practice/office-hours-tools.ts
/**
 * THE OFFICE-HOURS AGENT'S TOOLS (REQ-lec-12 to 14).
 *
 * `verdict` is registered ONLY when the learner's latest message is the
 * command /verdict: the gate is structural (the model cannot call a tool it
 * does not have), not a prompt promise. The command message is already in the
 * stored record when the turn starts (the chat handler persists the user
 * message before building the agent), which is what this reads.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../../core/native-messages.ts";
import { parseVerdictItem, type VerdictItem } from "../../../core/ext/practice/verdict.ts";
import { askUserQuestionTool } from "../../tools.ts";
import { invalidInputResult, toToolResult } from "../../tool-execute.ts";
import { healToolRecord } from "../../tools/heal.ts";

export const VERDICT_COMMAND = "/verdict";
export const MAX_SOURCE_CHARS = 30_000;

export interface VerdictReport {
	/** Text relayed to the model (and so to the learner). */
	text: string;
}

export interface OfficeHoursToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
	/** The designated source, or null when the session has none. */
	source(): { label: string; text: string } | null;
	/** Checks the items against the source and the work, records the verdict (and the grading of an exercise). */
	submitVerdict(items: VerdictItem[], work: string): VerdictReport;
}

function textOf(m: LhMessage): string {
	if (m.role !== "user") return "";
	const c = m.content as unknown;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join("\n");
	return "";
}

/** The user's messages in order, command messages excluded. */
export function learnerTexts(messages: readonly LhMessage[]): string[] {
	return messages.map(textOf).filter((t) => t.trim() !== "" && !t.trim().startsWith(VERDICT_COMMAND));
}

/** True when the newest user message is the verdict command. */
export function verdictRequested(messages: readonly LhMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "user") continue;
		return textOf(m).trim().startsWith(VERDICT_COMMAND);
	}
	return false;
}

const emptyInput = Type.Object({});
const verdictInput = Type.Object({
	items: Type.Array(
		Type.Object({
			stepRef: Type.String({ minLength: 1 }),
			sourceQuote: Type.String({ description: "Copied exactly from the designated source." }),
			workQuote: Type.String({ description: "Copied exactly from the learner's work; empty only for stance missing." }),
			stance: Type.Union([Type.Literal("matches"), Type.Literal("differs"), Type.Literal("missing")]),
		}),
		{ maxItems: 40 },
	),
});

export function officeHoursTools(ctx: OfficeHoursToolContext): Record<string, AgentTool<any>> {
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];

	const read_source: AgentTool<typeof emptyInput> = {
		name: "read_source",
		label: "read_source",
		description: "Read the session's designated source (the text the learner's work is compared with). Reports when none is designated.",
		parameters: emptyInput,
		executionMode: "sequential",
		execute: async () => {
			const s = ctx.source();
			if (s === null) return toToolResult("No source is designated for this session. No verdict is possible; keep to questions.");
			const clipped = s.text.length > MAX_SOURCE_CHARS ? `${s.text.slice(0, MAX_SOURCE_CHARS)}\n[truncated]` : s.text;
			return toToolResult(`DESIGNATED SOURCE: ${s.label}\n\n${clipped}`);
		},
	};

	const tools: Record<string, AgentTool<any>> = { read_source, ask_user_question: askUserQuestionTool };

	if (verdictRequested(messages)) {
		// The verdict is recorded (and an exercise graded) once per turn: a repeat call would record a second, possibly contradictory, verdict.
		let submitted = false;
		const verdict: AgentTool<typeof verdictInput> = {
			name: "verdict",
			label: "verdict",
			description:
				"Give the verdict on the learner's work against the designated source. Pass comparison items with EXACT quotations from the source and from the work; code checks them. Call once.",
			parameters: verdictInput,
			executionMode: "sequential",
			execute: async (_id, input) => {
				if (submitted) return invalidInputResult("verdict", ["the verdict was already recorded this turn; do not call verdict again"]);
				const items: VerdictItem[] = [];
				for (const raw of input.items) {
					const item = parseVerdictItem(raw);
					if (item === null) return invalidInputResult("verdict", ["malformed item"]);
					items.push(item);
				}
				try {
					const report = ctx.submitVerdict(items, learnerTexts(messages).join("\n\n"));
					submitted = true;
					return { ...toToolResult(report.text), details: { kind: "verdict" } };
				} catch (e) {
					return invalidInputResult("verdict", [e instanceof Error ? e.message : String(e)]);
				}
			},
		};
		tools.verdict = verdict;
	}
	return healToolRecord(tools);
}
