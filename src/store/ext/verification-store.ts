// src/store/ext/verification-store.ts
import { parseVerificationEvent } from "../../core/ext/trust.ts";
import type { VerificationStore } from "../../core/ext/ports.ts";
import { createLedger } from "./ledger.ts";

export function createVerificationStore(dir: string): VerificationStore {
	const ledger = createLedger(dir, "verification.jsonl", parseVerificationEvent);
	return { appendEvent: (e) => ledger.append(e), readEvents: () => ledger.readAll() };
}
