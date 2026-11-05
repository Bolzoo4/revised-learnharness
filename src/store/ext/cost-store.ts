// src/store/ext/cost-store.ts
import { parseCostEvent, type CostStore } from "../../core/ext/cost-gate.ts";
import { createLedger } from "./ledger.ts";

export function createCostStore(dir: string): CostStore {
	const ledger = createLedger(dir, "cost.jsonl", parseCostEvent);
	return { appendEvent: (e) => ledger.append(e), readEvents: () => ledger.readAll() };
}
