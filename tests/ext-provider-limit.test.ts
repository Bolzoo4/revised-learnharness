// tests/ext-provider-limit.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCostGate, type CostEvent } from "../src/core/ext/cost-gate.ts";
import {
	BASE_PAUSE_MS,
	CAP_PAUSE_MS,
	MAX_PAUSE_MS,
	MIN_PAUSE_MS,
	PROVIDER_LIMIT_MESSAGE,
	isProviderLimitMessage,
	nextPauseMs,
	parseResetHint,
} from "../src/core/ext/provider-limit.ts";

const MIN = 60_000;

describe("isProviderLimitMessage: real upstream and provider texts are limits", () => {
	const limits = [
		"Claude Code usage limit reached. Check your provider account and try again later. No API-key fallback was used.",
		"ChatGPT plan usage limit reached. Manage usage at https://chatgpt.com/settings. No API-key fallback was used.",
		"subscription_sharing_usage_limit_exceeded",
		"429 Too Many Requests",
		"HTTP 429: rate limit exceeded",
		"rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
		"rate-limit reached for this account",
		"Too many requests, slow down",
		"Overloaded",
		"overloaded_error: the service is temporarily overloaded",
		"You exceeded your current quota, please check your plan and billing details.",
		"Server is over capacity, try again",
		"We are at capacity right now",
		"5-hour limit reached ∙ resets 1:40am",
	];
	for (const text of limits) {
		it(`true for ${JSON.stringify(text.slice(0, 60))}`, () => assert.equal(isProviderLimitMessage(text), true));
	}
});

describe("isProviderLimitMessage: other failures are not limits (negative table)", () => {
	const notLimits = [
		"context length exceeded",
		"This model's maximum context length is 200000 tokens. However, your messages resulted in 250000 tokens.",
		"too many tokens in prompt",
		"The output token limit was reached",
		"the context window limit reached",
		"invalid api key",
		"401 Unauthorized: invalid x-api-key",
		"model not found: claude-foo",
		"aborted",
		"The request was aborted by the user.",
		"limit",
		"the limit of attempts is set in the config",
		"ECONNRESET while reading the response",
		"A reconnect is needed. Check the account access and provider limits, then retry.",
		"4290 rows were skipped",
		"",
	];
	for (const text of notLimits) {
		it(`false for ${JSON.stringify(text.slice(0, 60))}`, () => assert.equal(isProviderLimitMessage(text), false));
	}
	it("false for non-strings and missing values", () => {
		for (const v of [undefined, null, 429, {}, ["usage limit reached"]]) assert.equal(isProviderLimitMessage(v), false);
	});
});

describe("parseResetHint", () => {
	const now = new Date(2026, 10, 6, 23, 0, 0).getTime(); // local 23:00
	it("reads retry-after as seconds", () => {
		assert.equal(parseResetHint("rate limited, retry-after: 120", now), now + 120_000);
		assert.equal(parseResetHint("Retry-After 30", now), now + 30_000);
	});
	it("reads try-again-in with a unit", () => {
		assert.equal(parseResetHint("Limit reached. try again in 5 minutes", now), now + 5 * MIN);
		assert.equal(parseResetHint("try again in 2 hours", now), now + 2 * 3_600_000);
		assert.equal(parseResetHint("try again in 1 second", now), now + 1_000);
	});
	it("reads a clock reset as the next such local time after now", () => {
		const at = (h: number, m: number, from: number) => {
			const d = new Date(from);
			d.setHours(h, m, 0, 0);
			if (d.getTime() <= from) d.setDate(d.getDate() + 1);
			return d.getTime();
		};
		assert.equal(parseResetHint("5-hour limit reached ∙ resets 1:40am", now), at(1, 40, now));
		assert.equal(parseResetHint("limit reached, resets 12:05pm", now), at(12, 5, now));
		assert.equal(parseResetHint("limit reached, resets 12:00am", now), at(0, 0, now));
		const morning = new Date(2026, 10, 6, 0, 30, 0).getTime();
		assert.equal(parseResetHint("resets 1:40am", morning), new Date(2026, 10, 6, 1, 40, 0).getTime(), "later the same day when still ahead");
	});
	it("null when no clear reset time is named, or the time is not valid", () => {
		assert.equal(parseResetHint("usage limit reached", now), null);
		assert.equal(parseResetHint("resets 13:40", now), null, "24-hour clock without am/pm is not read");
		assert.equal(parseResetHint("resets 0:30pm", now), null);
		assert.equal(parseResetHint("resets 1:75am", now), null);
		assert.equal(parseResetHint(undefined, now), null);
		assert.equal(parseResetHint("retry-after: 120", Number.NaN), null);
	});
});

describe("nextPauseMs (backoff)", () => {
	it("starts at 30 minutes and doubles per consecutive hit", () => {
		assert.equal(nextPauseMs(1), BASE_PAUSE_MS);
		assert.equal(nextPauseMs(1), 30 * MIN);
		assert.equal(nextPauseMs(2), 60 * MIN);
		assert.equal(nextPauseMs(3), 120 * MIN);
		assert.equal(nextPauseMs(4), 240 * MIN);
	});
	it("caps at 6 hours and stays there", () => {
		assert.equal(nextPauseMs(5), CAP_PAUSE_MS);
		assert.equal(nextPauseMs(5), 6 * 60 * MIN);
		assert.equal(nextPauseMs(9), CAP_PAUSE_MS);
		assert.equal(nextPauseMs(10_000), CAP_PAUSE_MS, "no overflow far past the cap");
	});
	it("treats a missing or invalid hit count as the first hit", () => {
		assert.equal(nextPauseMs(0), BASE_PAUSE_MS);
		assert.equal(nextPauseMs(-4), BASE_PAUSE_MS);
		assert.equal(nextPauseMs(Number.NaN), BASE_PAUSE_MS);
	});
	it("a reset hint overrides the backoff", () => {
		assert.equal(nextPauseMs(4, 10 * MIN), 10 * MIN);
		assert.equal(nextPauseMs(1, 3 * 3_600_000), 3 * 3_600_000);
	});
	it("clamps a hint to [1 min, 24 h]", () => {
		assert.equal(nextPauseMs(1, 5_000), MIN_PAUSE_MS, "5 seconds is raised to one minute");
		assert.equal(nextPauseMs(1, 0), MIN_PAUSE_MS);
		assert.equal(nextPauseMs(1, -90 * MIN), MIN_PAUSE_MS);
		assert.equal(nextPauseMs(1, 48 * 3_600_000), MAX_PAUSE_MS, "48 hours is cut to a day");
	});
	it("ignores a non-finite hint and uses the backoff", () => {
		assert.equal(nextPauseMs(2, Number.NaN), 60 * MIN);
		assert.equal(nextPauseMs(2, null), 60 * MIN);
	});
});

describe("CostGate with a provider pause", () => {
	const at = (iso: string) => iso;
	function mem() {
		const events: CostEvent[] = [];
		return { events, store: { appendEvent: (e: CostEvent) => void events.push(e), readEvents: () => [...events] } };
	}
	const NOW = Date.parse("2026-11-06T10:00:00.000Z");
	const UNTIL = NOW + 30 * MIN;

	it("is closed while the pause holds, with reason provider-limit, even under the ceiling", () => {
		const { store } = mem();
		let now = at(new Date(NOW).toISOString());
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now, providerPause: { isPaused: (ms) => ms < UNTIL } });
		assert.equal(gate.allowed(), false);
		assert.equal(gate.reason?.(), "provider-limit");
		now = new Date(NOW + MIN).toISOString();
		assert.equal(gate.allowed(), false);
	});
	it("reopens exactly at the pause end (inclusive of the end instant)", () => {
		const { store } = mem();
		let now = new Date(UNTIL - 1).toISOString();
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now, providerPause: { isPaused: (ms) => ms < UNTIL } });
		assert.equal(gate.allowed(), false, "one millisecond before the end is still paused");
		now = new Date(UNTIL).toISOString();
		assert.equal(gate.allowed(), true);
		assert.equal(gate.reason?.(), null);
	});
	it("the provider pause wins the reason when the ceiling is also spent (transient beats permanent)", () => {
		const { store } = mem();
		const now = new Date(NOW).toISOString();
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now, providerPause: { isPaused: () => true } });
		gate.record(5, "verification");
		assert.equal(gate.reason?.(), "provider-limit");
	});
	it("reports ceiling when only the ceiling is spent, and nothing when open", () => {
		const { store } = mem();
		const now = new Date(NOW).toISOString();
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now, providerPause: { isPaused: () => false } });
		assert.equal(gate.reason?.(), null);
		gate.record(1, "research");
		assert.equal(gate.allowed(), false);
		assert.equal(gate.reason?.(), "ceiling");
	});
	it("a gate without a pause behaves exactly as before", () => {
		const { store } = mem();
		const now = new Date(NOW).toISOString();
		const gate = createCostGate({ store, ceilingUsd: 1, now: () => now });
		assert.equal(gate.allowed(), true);
		assert.equal(gate.reason?.(), null);
	});
	it("the fixed message is the only text the pause exposes", () => {
		assert.equal(PROVIDER_LIMIT_MESSAGE, "The AI provider's usage limit is reached; try again later.");
	});
});
