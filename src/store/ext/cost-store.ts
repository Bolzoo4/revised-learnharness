// src/store/ext/cost-store.ts
import { parseCostEvent, type CostStore } from "../../core/ext/cost-gate.ts";
import { createLedger } from "./ledger.ts";

/** The spend ledger of a gate: cost.jsonl (the model ceiling) unless another file is named (the audio ceiling). */
export function createCostStore(dir: string, fileName: string = "cost.jsonl"): CostStore {
	const ledger = createLedger(dir, fileName, parseCostEvent);
	return { appendEvent: (e) => ledger.append(e), readEvents: () => ledger.readAll() };
}
