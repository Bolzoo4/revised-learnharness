// src/agent/ext/review-tools.ts
/**
 * THE REVIEW AGENT'S TOOLS (personal-layer spec REQ-pl-06, REQ-pl-07).
 * `next_item` presents the head of today's plan; `record_review` writes the
 * learner-confirmed rating; `propose_card` drafts a card (never active).
 * Questions to the learner go through upstream's own `ask_user_question`
 * (free recall = no options; multiple choice = options), so the existing
 * chat UI is the whole surface.
 *
 * Duration is MEASURED, not declared: the time between the `next_item`
 * result that presented a node and the `record_review` for it. The tool
 * also decides the channel (from what `next_item` presented) so the model
 * cannot mislabel a review.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../../core/native-messages.ts";
import type { NextItem } from "../../core/ext/review-queries.ts";
import type { RecordReviewInput, RecordReviewResult } from "../../core/ext/review-service.ts";
import { askUserQuestionTool } from "../tools.ts";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import { healToolRecord } from "../tools/heal.ts";

export const MAX_REVIEW_SEC = 900; // an item left open longer than this counts as 15 minutes

export interface ReviewToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	nextItem(): NextItem;
	record(input: RecordReviewInput): RecordReviewResult;
	proposeCard(input: { nodeId: string; question: string; answer: string }): string;
	/** Epoch milliseconds; injectable for tests. */
	nowMs?: () => number;
}

interface Shown {
	at: number;
	channel: "fixed" | "dialogic";
}

/**
 * When was `nodeId` last presented and not yet recorded? Turn-local memory
 * first (the record only lands at turn end), then the stored record: scan
 * back for the newest `next_item` result for the node, stopping at a clean
 * `record_review` for it (that presentation is already used up).
 */
function findShown(ctx: ReviewToolContext, nodeId: string, local: Map<string, Shown>): Shown | undefined {
	const mine = local.get(nodeId);
	if (mine !== undefined) return mine;
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.isError) continue;
		const d = m.details as { kind?: string; nodeId?: string; channel?: string } | null | undefined;
		if (m.toolName === "record_review" && d?.nodeId === nodeId) return undefined;
		if (m.toolName === "next_item" && d?.kind === "item" && d.nodeId === nodeId) {
			if (d.channel !== "fixed" && d.channel !== "dialogic") return undefined;
			return { at: m.timestamp, channel: d.channel };
		}
	}
	return undefined;
}

const emptyInput = Type.Object({});

const recordInput = Type.Object({
	nodeId: Type.String({ minLength: 1, description: "The node id exactly as next_item presented it." }),
	rating: Type.Integer({
		minimum: 1,
		maximum: 4,
		description: "The rating the LEARNER confirmed: 1 Again, 2 Hard, 3 Good, 4 Easy.",
	}),
	question: Type.Optional(Type.String({ description: "Dialogic only: the question you asked, verbatim." })),
	answer: Type.Optional(Type.String({ description: "The learner's answer, in one or two sentences." })),
	weakPremises: Type.Optional(
		Type.Array(Type.String(), { description: "Dialogic only: ids of premises the dialogue found weak (subset of the item's premises)." }),
	),
});

const proposeInput = Type.Object({
	nodeId: Type.String({ minLength: 1 }),
	question: Type.String({ minLength: 1, description: "A self-contained question answerable from memory." }),
	answer: Type.String({ minLength: 1, description: "The reference answer." }),
});

export function reviewTools(ctx: ReviewToolContext): Record<string, AgentTool<any>> {
	const nowMs = ctx.nowMs ?? Date.now;
	const local = new Map<string, Shown>();

	const next_item: AgentTool<typeof emptyInput> = {
		name: "next_item",
		label: "next_item",
		description:
			"Present the next node of today's review plan, or report that nothing is left. Returns the node, its trust level, its premises read from the current graph, " +
			"the fixed card to show (fixed channel only) and the questions already asked on this node. Call it at the start and after every recorded review.",
		parameters: emptyInput,
		executionMode: "sequential",
		execute: async () => {
			const item = ctx.nextItem();
			if (item.kind === "item") local.set(item.nodeId, { at: nowMs(), channel: item.channel });
			return toToolResult(item);
		},
	};

	const record_review: AgentTool<typeof recordInput> = {
		name: "record_review",
		label: "record_review",
		description:
			"Record the review of the node next_item presented, with the rating the learner confirmed. The channel and the duration are set by the system. " +
			"For a dialogic item pass the question you asked and any weak premises.",
		parameters: recordInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const shown = findShown(ctx, input.nodeId, local);
			if (shown === undefined) {
				return invalidInputResult("record_review", [
					"this node was not presented by next_item, or its review is already recorded — call next_item",
				]);
			}
			const durationSec = Math.min(MAX_REVIEW_SEC, Math.max(1, Math.round((nowMs() - shown.at) / 1000)));
			try {
				const res = ctx.record({
					nodeId: input.nodeId,
					channel: shown.channel,
					rating: input.rating,
					durationSec,
					...(input.question !== undefined ? { question: input.question } : {}),
					...(input.answer !== undefined ? { answer: input.answer } : {}),
					...(input.weakPremises !== undefined ? { weakPremises: input.weakPremises } : {}),
				});
				local.delete(input.nodeId);
				return {
					...toToolResult(
						`Recorded (${shown.channel}, ${durationSec}s). Next review ${res.dueAt}. ` +
							`Credited premises: ${res.credited.join(", ") || "none"}. Penalised premises: ${res.penalised.join(", ") || "none"}.`,
					),
					details: { nodeId: input.nodeId },
				};
			} catch (e) {
				return invalidInputResult("record_review", [e instanceof Error ? e.message : String(e)]);
			}
		},
	};

	const propose_card: AgentTool<typeof proposeInput> = {
		name: "propose_card",
		label: "propose_card",
		description:
			"Draft a fixed card for a node. It is stored as a DRAFT and is not scheduled until the learner approves it outside this chat.",
		parameters: proposeInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			try {
				const cardId = ctx.proposeCard(input);
				return toToolResult(`Draft ${cardId} saved. It is inactive until the learner approves it.`);
			} catch (e) {
				return invalidInputResult("propose_card", [e instanceof Error ? e.message : String(e)]);
			}
		},
	};

	return healToolRecord({ next_item, record_review, propose_card, ask_user_question: askUserQuestionTool });
}
