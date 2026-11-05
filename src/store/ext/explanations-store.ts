// src/store/ext/explanations-store.ts
import { parseExplanationEvent } from "../../core/ext/explanations.ts";
import type { ExplanationsStore } from "../../core/ext/node-knowledge-ports.ts";
import { createLedger } from "./ledger.ts";

export function createExplanationsStore(dir: string): ExplanationsStore {
	const ledger = createLedger(dir, "explanations.jsonl", parseExplanationEvent);
	return {
		appendEvent: (event) => ledger.append(event),
		readEvents: () => ledger.readAll(),
	};
}
