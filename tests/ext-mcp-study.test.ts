// tests/ext-mcp-study.test.ts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { startOfLocalDay } from "../src/core/ext/local-day.ts";
import { openCall } from "../src/core/ext/mcp/call.ts";
import { runTool } from "../src/core/ext/mcp/tools.ts";
import { computePlan } from "../src/core/ext/review-queries.ts";
import { cleanupAllFixtures, GOAL_ID, HIDDEN, makeFixture, N, NOW, seedGraph, seedStandard } from "./helpers/mcp-fixture.ts";
import { call, errorCode, expectError } from "./helpers/mcp-run.ts";

afterEach(cleanupAllFixtures);

const goalEvent = (targets: string[]) => ({
	type: "created", goalId: GOAL_ID, title: "Ready goal", origin: "user", originRef: "", targetNodeIds: targets, priority: 3, at: "2026-11-01T00:00:00.000Z",
});

describe("list_goals and get_goal (REQ-mcp-05)", () => {
	it("lists goals with scope size and the share of solid nodes, without the origin reference", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "list_goals");
		assert.equal(r.count, 1);
		assert.equal(r.truncated, false);
		const g = r.items[0];
		assert.equal(g.id, GOAL_ID);
		assert.equal(g.scopeSize, 4);
		assert.equal(g.targetCount, 1);
		assert.equal(g.solidShare, 0.25, "node A was reviewed and is the only solid one");
		assert.ok(!JSON.stringify(r).includes(HIDDEN.originRef));
	});

	it("filters by status; an unknown status is invalid input", () => {
		const f = makeFixture();
		seedStandard(f);
		assert.equal(call(f, "list_goals", { status: "active" }).count, 1);
		assert.equal(call(f, "list_goals", { status: "paused" }).count, 0);
		expectError(f, "list_goals", { status: "done" }, "invalid_input");
		expectError(f, "list_goals", { status: 3 }, "invalid_input");
	});

	it("get_goal: scope summary, due counts, targets and the exercise set state, without reference solutions", () => {
		const f = makeFixture();
		seedStandard(f);
		const g = call(f, "get_goal", { id: GOAL_ID });
		assert.equal(g.title, "Learn set order");
		assert.equal(g.scope.size, 4);
		assert.equal(g.due.dueNow + g.due.unseen + g.due.scheduled, 4);
		assert.equal(g.due.unseen, 2);
		assert.equal(g.targets.items[0].id, N.d);
		assert.deepEqual(g.exerciseSet, { state: "complete", exercises: 1, graded: 1 });
		const text = JSON.stringify(g);
		for (const secret of [HIDDEN.reference, HIDDEN.originRef]) assert.ok(!text.includes(secret));
	});

	it("exercise set states: none, complete, applied; the newest set wins; a graded event of an unknown set is ignored", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent([N.d]));
		assert.deepEqual(call(f, "get_goal", { id: GOAL_ID }).exerciseSet, { state: "none" });
		const ex = { id: "ex_1", prompt: "p", nodeIds: [N.a, N.c], steps: [{ id: "s1", text: "step", nodeIds: [N.a] }] };
		f.ext("exercises.jsonl", { type: "set_created", setId: "old", goalId: GOAL_ID, exercises: [ex], at: "2026-11-01T10:00:00.000Z" });
		f.ext("exercises.jsonl", { type: "graded", setId: "old", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [], lowConfidence: false, at: "2026-11-01T11:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "complete");
		f.ext("exercises.jsonl", { type: "applied", setId: "old", reached: false, at: "2026-11-01T12:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "applied");
		f.ext("exercises.jsonl", { type: "set_created", setId: "new", goalId: GOAL_ID, exercises: [ex], at: "2026-11-02T10:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "in_progress");
		f.ext("exercises.jsonl", { type: "graded", setId: "ghost", exerciseId: "ex_1", outcome: "consistent", nodeOutcomes: [], lowConfidence: false, at: "2026-11-02T11:00:00.000Z" });
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).exerciseSet.state, "in_progress");
	});

	it("unknown or malformed goal ids", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "get_goal", { id: "goal_nope" }, "not_found");
		for (const id of [undefined, "", 7, "a\nb", null, {}]) expectError(f, "get_goal", { id }, "invalid_input");
	});

	it("a target that no longer exists does not crash and counts as the app counts it", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent(["n_deleted"]));
		assert.equal(call(f, "get_goal", { id: GOAL_ID }).scope.size, 1, "the app counts the target itself in the scope");
		assert.equal(call(f, "list_goals").items[0].solidShare, 0);
	});

	it("study tools are disabled under --knowledge-only", () => {
		const f = makeFixture();
		seedStandard(f);
		expectError(f, "list_goals", {}, "disabled", true);
		expectError(f, "get_goal", { id: GOAL_ID }, "disabled", true);
		expectError(f, "get_daily_plan", {}, "disabled", true);
		expectError(f, "research_status", {}, "disabled", true);
	});
});

describe("get_daily_plan (REQ-mcp-05, REQ-mcp-07)", () => {
	it("gives the same numbers as the app's computePlan for the same data, time and defaults", () => {
		const f = makeFixture();
		seedStandard(f);
		const plan = call(f, "get_daily_plan");
		const open = openCall(f.deps);
		const { plan: app } = computePlan({ ...open.review, now: () => NOW }, startOfLocalDay(new Date(NOW)));
		assert.equal(plan.due.total, app.due);
		assert.equal(plan.capacity, app.capacity);
		assert.equal(plan.newCardQuota, app.newQuota);
		assert.equal(plan.deferred, app.deferred.length);
		assert.equal(plan.needsCard, app.needsCard.length);
		assert.equal(plan.planned.total, app.items.length);
		assert.equal(plan.remainingMinutes, Math.round((app.remainingSec / 60) * 10) / 10);
		assert.equal(plan.budgetMinutes, 25);
	});

	it("an empty learner yields an empty plan, not an error", () => {
		const f = makeFixture();
		const p = call(f, "get_daily_plan");
		assert.equal(p.planned.total, 0);
		assert.equal(p.exerciseSetPending, false);
		assert.equal(p.pendingGoals.count, 0);
	});

	it("date: today is the default; a future date plans that day; past, far-future and non-dates are refused", () => {
		const f = makeFixture();
		seedStandard(f);
		const today = call(f, "get_daily_plan");
		assert.deepEqual(call(f, "get_daily_plan", { date: today.date }), today);
		const t = new Date(NOW);
		t.setDate(t.getDate() + 1);
		const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
		const future = call(f, "get_daily_plan", { date: iso });
		assert.equal(future.date, iso);
		assert.equal(future.spentMinutes, 0);
		assert.ok(future.due.total >= today.due.total);
		expectError(f, "get_daily_plan", { date: "2020-01-01" }, "invalid_input");
		expectError(f, "get_daily_plan", { date: "2099-01-01" }, "invalid_input");
		for (const date of ["2026-02-30", "tomorrow", "2026-11-4", 20261104, null, ""]) expectError(f, "get_daily_plan", { date }, "invalid_input");
	});

	it("exerciseSetPending: a goal that is solid and has no applied set is pending", () => {
		const f = makeFixture();
		seedGraph(f);
		f.ext("goals.jsonl", goalEvent([N.lone]));
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, false, "nothing reviewed yet: not ready");
		for (const at of ["2026-11-04T08:00:00.000Z", "2026-11-04T08:10:00.000Z", "2026-11-04T08:20:00.000Z"]) {
			f.ext("review.jsonl", { type: "review", nodeId: N.lone, channel: "fixed", rating: 4, durationSec: 10, at });
		}
		const p = call(f, "get_daily_plan");
		assert.equal(p.exerciseSetPending, true);
		assert.equal(p.pendingGoals.items[0].id, GOAL_ID);
		f.ext("exercises.jsonl", { type: "set_created", setId: "s", goalId: GOAL_ID, exercises: [{ id: "e", prompt: "p", nodeIds: [N.lone], steps: [{ id: "s1", text: "t", nodeIds: [N.lone] }] }], at: "2026-11-04T09:00:00.000Z" });
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, true, "a set that is not applied is still pending");
		f.ext("exercises.jsonl", { type: "applied", setId: "s", reached: true, at: "2026-11-04T10:00:00.000Z" });
		assert.equal(call(f, "get_daily_plan").exerciseSetPending, false);
	});

	it("replay failures outside the first guarded read are data_inconsistent too, and never carry the raw message", () => {
		const f = makeFixture();
		seedStandard(f);
		const broken = (owner: Record<string, unknown>, key: string) => {
			const real = owner[key];
			owner[key] = () => {
				throw new Error("/Users/secret/ext/corrupt.jsonl: bad event");
			};
			return () => (owner[key] = real);
		};
		const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
			["search_nodes", { query: "set", goalId: GOAL_ID }, "readEvents", f.deps.review.goalsStore as unknown as Record<string, unknown>],
			["get_node", { id: N.a }, "readEvents", f.deps.review.goalsStore as unknown as Record<string, unknown>],
			["list_documents", {}, "readAll", f.deps.documents as unknown as Record<string, unknown>],
			["get_recent_debriefs", {}, "readAll", f.deps.journal as unknown as Record<string, unknown>],
			["research_status", {}, "readAll", f.deps.frontier as unknown as Record<string, unknown>],
		];
		for (const [tool, input, key, owner] of cases) {
			const restore = broken(owner, key);
			try {
				assert.equal(errorCode(f, tool, input), "data_inconsistent", tool);
				const message = (() => {
					try {
						runTool(tool, f.deps, input, { knowledgeOnly: false });
						return "";
					} catch (e) {
						return e instanceof Error ? e.message : "";
					}
				})();
				assert.ok(!message.includes("/Users/secret"), `${tool} leaked: ${message}`);
			} finally {
				restore();
			}
		}
		assert.equal(errorCode(f, "list_documents", {}), "none", "the next call still works");
	});

	it("an unreplayable review history is a fixed-text data_inconsistent error and the next call still works", () => {
		const f = makeFixture();
		seedStandard(f);
		let broken = true;
		const real = f.deps.review.reviewStore.readEvents;
		f.deps.review.reviewStore.readEvents = () => {
			if (broken) throw new Error("/Users/secret/ext/review.jsonl exploded");
			return real();
		};
		for (const [tool, input] of [["get_daily_plan", {}], ["list_goals", {}], ["get_goal", { id: GOAL_ID }]] as const) {
			assert.equal(errorCode(f, tool, input), "data_inconsistent", tool);
		}
		assert.equal(call(f, "get_node", { id: N.a }).reviewUnavailable, true);
		broken = false;
		assert.equal(errorCode(f, "get_daily_plan"), "none");
	});
});

describe("research_status (REQ-mcp-05)", () => {
	it("summarises marks, inbox size and the last cycle without locators, rationale, errors or steering text", () => {
		const f = makeFixture();
		seedStandard(f);
		const r = call(f, "research_status");
		assert.deepEqual(r.frontier.items[0], {
			id: "mark_1", scope: { kind: "goal", id: GOAL_ID }, mark: "expand", maxDepth: 2,
			note: "grow the set theory area", author: "user", at: "2026-11-03T12:00:00.000Z",
		});
		assert.deepEqual(r.inbox, { pending: 1, approved: 0, rejected: 1, activated: 0, total: 2 });
		assert.equal(r.lastCycle.cycleId, "cyc_1");
		assert.equal(r.lastCycle.gaps, 1);
		assert.equal(r.lastCycle.nodesAdded, 2);
		assert.deepEqual(r.lastCycle.watch, { entries: 1, items: 3, ingested: 1, inbox: 2 });
		const text = JSON.stringify(r);
		for (const secret of [HIDDEN.locator, HIDDEN.researchError, HIDDEN.steer, HIDDEN.rationale]) assert.ok(!text.includes(secret), secret);
	});

	it("no cost figure leaves the server: no key names cost or budget at any depth, even when the ledgers carry them", () => {
		const f = makeFixture();
		seedStandard(f);
		const keys: string[] = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
		};
		walk(call(f, "research_status"));
		assert.deepEqual(keys.filter((k) => /cost|budget|usd/i.test(k)), [], "the output has no cost field");
		assert.ok(!JSON.stringify(call(f, "research_status")).includes("costUsd"));
	});

	it("nothing yet: empty marks, zero inbox, no cycle", () => {
		const f = makeFixture();
		assert.deepEqual(call(f, "research_status"), {
			frontier: { items: [], count: 0, truncated: false },
			inbox: { pending: 0, approved: 0, rejected: 0, activated: 0, total: 0 },
			lastCycle: null,
		});
	});

	it("marks are bounded and the newest comes first", () => {
		const f = makeFixture();
		for (let i = 0; i < 30; i++) {
			f.ext("frontier.jsonl", { type: "set", markId: `m${i}`, scope: { kind: "node", id: N.a }, mark: "hold", note: "n", author: "agent", at: `2026-11-04T00:${String(i).padStart(2, "0")}:00.000Z` });
		}
		const r = call(f, "research_status");
		assert.equal(r.frontier.truncated, true);
		assert.ok(r.frontier.items.length <= 20);
		assert.equal(r.frontier.items[0].id, "m29");
	});
});
