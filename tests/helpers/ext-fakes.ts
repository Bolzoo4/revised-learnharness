// tests/helpers/ext-fakes.ts
import type { CostGate } from "../../src/core/ext/cost-gate.ts";
import type { GoalsStore, SnapshotStore, SourcesStore, VerificationStore } from "../../src/core/ext/ports.ts";
import type { GoalEvent } from "../../src/core/ext/goals.ts";
import type { SourceEntry } from "../../src/core/ext/sources.ts";
import type { VerificationEvent } from "../../src/core/ext/trust.ts";

export function memSourcesStore(initial: SourceEntry[] = []): SourcesStore {
	let entries = initial.map((e) => ({ ...e }));
	return { read: () => entries.map((e) => ({ ...e })), write: (next) => void (entries = next.map((e) => ({ ...e }))) };
}

export function memSnapshotStore(): SnapshotStore & { texts: Map<string, string> } {
	const texts = new Map<string, string>();
	return {
		texts,
		put(text) {
			for (const [h, t] of texts) if (t === text) return h;
			const h = `h${texts.size + 1}`;
			texts.set(h, text);
			return h;
		},
	};
}

export function memVerificationStore(): VerificationStore & { events: VerificationEvent[] } {
	const events: VerificationEvent[] = [];
	return { events, appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export function memGoalsStore(events: GoalEvent[] = []): GoalsStore {
	return { appendEvent: (e) => void events.push(e), readEvents: () => [...events] };
}

export function fakeGate(initiallyAllowed = true): CostGate & { open: boolean; recorded: { usd: number; source: string }[] } {
	const gate = {
		open: initiallyAllowed,
		recorded: [] as { usd: number; source: string }[],
		allowed: () => gate.open,
		record: (usd: number, source: string) => void gate.recorded.push({ usd, source }),
	};
	return gate;
}

export function node(id: string, statement = `Statement of ${id}.`) {
	return { id, name: id, statement, aliases: [], createdAt: "2026-11-04T00:00:00.000Z", provenance: [] };
}
