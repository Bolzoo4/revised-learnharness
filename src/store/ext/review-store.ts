import type { ReviewStore } from "../../core/ext/ports.ts";
import { parseReviewEvent } from "../../core/ext/review.ts";
import { createLedger } from "./ledger.ts";

export function createReviewStore(dir: string): ReviewStore {
	const ledger = createLedger(dir, "review.jsonl", parseReviewEvent);
	return { appendEvent: (event) => ledger.append(event), readEvents: () => ledger.readAll() };
}
