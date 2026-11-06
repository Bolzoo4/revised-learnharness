// tests/ext-mcp-debriefs.test.ts
/** get_recent_debriefs (REQ-mcp-13). Needs src/core/ext/debrief/journal.ts from the session-debriefs plan. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SESSION_KINDS, debriefId } from "../src/core/ext/debrief/journal.ts";
import { LIMITS } from "../src/core/ext/mcp/limits.ts";
import { DEBRIEF_KINDS } from "../src/server/ext/mcp/catalog.ts";
import { cleanupAllFixtures, makeFixture, type Fixture } from "./helpers/mcp-fixture.ts";
import { call, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const session = (sessionId: string, sessionKind: string, at: string, over: Record<string, unknown> = {}) => ({
	id: debriefId(sessionId), kind: "session", sessionId, sessionKind, weekOf: null, at,
	facts: { kind: sessionKind, cards: 3 }, commentary: `Commentary of ${sessionId}`, nullReason: null, author: "agent", ...over,
});
const weekly = (weekOf: string, at: string) => ({
	id: debriefId(`weekly:${weekOf}`), kind: "weekly", sessionId: null, sessionKind: null, weekOf, at,
	facts: { kind: "weekly", sessions: 4 }, commentary: "Weekly text", nullReason: null, author: "agent",
});

function seedJournal(f: Fixture): void {
	f.ext("journal.jsonl", session("s1", "review", "2026-11-01T10:00:00.000Z"));
	f.ext("journal.jsonl", session("s2", "lecture", "2026-11-02T10:00:00.000Z"));
	f.ext("journal.jsonl", session("s3", "review", "2026-11-03T10:00:00.000Z"));
	f.ext("journal.jsonl", weekly("2026-10-26", "2026-11-02T08:00:00.000Z"));
	f.ext("journal.jsonl", weekly("2026-11-02", "2026-11-04T08:00:00.000Z"));
}

describe("get_recent_debriefs (REQ-mcp-13)", () => {
	it("the zod kind list is the journal's session kinds plus weekly", () => {
		assert.deepEqual([...DEBRIEF_KINDS], [...SESSION_KINDS, "weekly"]);
	});

	it("newest first, with the latest weekly synthesis alongside, bounded and paged", () => {
		const f = makeFixture();
		seedJournal(f);
		const r = call(f, "get_recent_debriefs");
		assert.deepEqual(r.debriefs.items.map((e: { at: string }) => e.at), [
			"2026-11-04T08:00:00.000Z", "2026-11-03T10:00:00.000Z", "2026-11-02T10:00:00.000Z", "2026-11-02T08:00:00.000Z", "2026-11-01T10:00:00.000Z",
		]);
		assert.equal(r.debriefs.count, 5);
		assert.equal(r.debriefs.truncated, false);
		assert.equal(r.latestWeekly.weekOf, "2026-11-02");
		assert.deepEqual(r.latestWeekly.facts, { kind: "weekly", sessions: 4 });
		assert.ok(!("sessionId" in r.debriefs.items[1]), "no internal chat id is exposed");
	});

	it("filters by kind and since; limit truncates explicitly", () => {
		const f = makeFixture();
		seedJournal(f);
		assert.equal(call(f, "get_recent_debriefs", { kind: "review" }).debriefs.count, 2);
		assert.equal(call(f, "get_recent_debriefs", { kind: "weekly" }).debriefs.count, 2);
		assert.equal(call(f, "get_recent_debriefs", { since: "2026-11-03T00:00:00Z" }).debriefs.count, 2);
		const two = call(f, "get_recent_debriefs", { limit: 2 });
		assert.equal(two.debriefs.count, 2);
		assert.equal(two.debriefs.truncated, true);
		assert.equal(two.latestWeekly.weekOf, "2026-11-02", "the weekly synthesis does not depend on the page");
	});

	it("rejects unknown kinds, zone-less or unparseable instants; falls back for bad limits", () => {
		const f = makeFixture();
		seedJournal(f);
		for (const input of [{ kind: "daily" }, { since: "2026-11-03" }, { since: "yesterday" }, { since: 5 }, { kind: 3 }]) {
			expectError(f, "get_recent_debriefs", input, "invalid_input");
		}
		for (const limit of [Number.NaN, 0, -2, 2.5, 1e9, "3"]) {
			const r = call(f, "get_recent_debriefs", { limit });
			assert.ok(r.debriefs.count >= 1 && r.debriefs.count <= LIMITS.debriefsMax);
		}
	});

	it("a duplicate key keeps the first debrief; corrupt lines and invalid events are skipped", () => {
		const f = makeFixture();
		f.ext("journal.jsonl", session("dup", "study", "2026-11-01T10:00:00.000Z", { commentary: "first" }));
		f.ext("journal.jsonl", session("dup", "study", "2026-11-02T10:00:00.000Z", { commentary: "second" }));
		f.ext("journal.jsonl", "{not json");
		f.ext("journal.jsonl", { id: "x", kind: "session" });
		const r = call(f, "get_recent_debriefs");
		assert.equal(r.debriefs.count, 1);
		assert.equal(r.debriefs.items[0].commentary, "first");
	});

	it("oversized commentary is capped with the marker and oversized facts are replaced by a marker", () => {
		const f = makeFixture();
		f.ext("journal.jsonl", session("big", "review", "2026-11-01T10:00:00.000Z", { commentary: "c".repeat(20_000), facts: { kind: "review", blob: "f".repeat(20_000) } }));
		const e = call(f, "get_recent_debriefs").debriefs.items[0];
		assert.match(e.commentary, /… \[truncated: \d+ more characters\]$/);
		assert.deepEqual(e.facts, { kind: "review", omitted: "facts exceed the size limit" });
	});

	it("a null commentary (ceiling or error) is reported with its reason; nothing yet gives an empty page", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "get_recent_debriefs"), { debriefs: { items: [], count: 0, truncated: false }, latestWeekly: null });
		f.ext("journal.jsonl", session("n", "review", "2026-11-01T10:00:00.000Z", { commentary: null, nullReason: "ceiling" }));
		const e = call(f, "get_recent_debriefs").debriefs.items[0];
		assert.equal(e.commentary, null);
		assert.equal(e.nullReason, "ceiling");
	});

	it("is disabled by --knowledge-only", () => {
		const f = makeFixture();
		seedJournal(f);
		expectError(f, "get_recent_debriefs", {}, "disabled", true);
	});
});
