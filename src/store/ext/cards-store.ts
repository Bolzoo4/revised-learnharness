import { parseCardEvent } from "../../core/ext/cards.ts";
import type { CardsStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createCardsStore(dir: string): CardsStore {
	const ledger = createLedger(dir, "cards.jsonl", parseCardEvent);
	return { appendEvent: (event) => ledger.append(event), readEvents: () => ledger.readAll() };
}
