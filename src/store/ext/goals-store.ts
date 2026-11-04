import { parseGoalEvent } from "../../core/ext/goals.ts";
import type { GoalsStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createGoalsStore(dir: string): GoalsStore {
	const ledger = createLedger(dir, "goals.jsonl", parseGoalEvent);
	return {
		appendEvent: (event) => ledger.append(event),
		readEvents: () => ledger.readAll(),
	};
}
