// tests/ext-provider-pause.test.ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withProviderLimitObserver } from "../src/agent/ext/limit-aware-engine.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { MIN_PAUSE_MS, PROVIDER_LIMIT_MESSAGE } from "../src/core/ext/provider-limit.ts";
import { noteProviderLimit, noteProviderSuccess, observedEngine, providerPauseStatus, providerPauseView, resetProviderPauseForTests } from "../src/server/ext/provider-pause.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const LIMIT = "Claude Code usage limit reached. Check your provider account and try again later. No API-key fallback was used.";
const CANARY = "sk-CANARY-7731-secret https://leak.example/?token=CANARY-URL";

beforeEach(() => resetProviderPauseForTests());
afterEach(() => resetProviderPauseForTests());

function assistant(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: T0,
	} as unknown as AssistantMessage;
}

/** A stream that ends with the given final message, as a provider stream does. */
function streamEnding(message: AssistantMessage): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	if (message.stopReason === "error") s.push({ type: "error", reason: "error", error: message });
	else s.push({ type: "done", reason: "stop", message });
	return s;
}

const engineWith = (make: () => AssistantMessageEventStream): PiEngine =>
	({ model: {} as never, streamFn: (() => make()) as never }) as PiEngine;

describe("noteProviderLimit and the pause window", () => {
	it("a limit pauses for 30 minutes from the moment it is seen", () => {
		noteProviderLimit(LIMIT, T0);
		const status = providerPauseStatus(T0);
		assert.equal(status.paused, true);
		assert.equal(status.pausedUntil, new Date(T0 + 30 * MIN).toISOString());
		assert.equal(status.message, PROVIDER_LIMIT_MESSAGE);
	});
	it("text that is not a limit does not pause anything", () => {
		noteProviderLimit("context length exceeded", T0);
		noteProviderLimit("invalid api key", T0);
		assert.equal(providerPauseStatus(T0).paused, false);
	});
	it("the gate reopens exactly at the pause end and not a millisecond before", () => {
		noteProviderLimit(LIMIT, T0);
		const until = T0 + 30 * MIN;
		assert.equal(providerPauseView.isPaused(until - 1), true);
		assert.equal(providerPauseView.isPaused(until), false);
		assert.equal(providerPauseStatus(until).paused, false);
	});
	it("a reset hint in the provider's words sets the pause end", () => {
		noteProviderLimit("usage limit reached, try again in 5 minutes", T0);
		assert.equal(providerPauseStatus(T0).pausedUntil, new Date(T0 + 5 * MIN).toISOString());
	});
	it("a tiny hint is clamped to the one-minute floor", () => {
		noteProviderLimit("usage limit reached, retry-after: 3", T0);
		assert.equal(providerPauseStatus(T0).pausedUntil, new Date(T0 + MIN_PAUSE_MS).toISOString());
	});
});

describe("hits: doubling, no double count, success reset", () => {
	it("no double count: limits seen while a pause holds count as one hit", () => {
		noteProviderLimit(LIMIT, T0);
		noteProviderLimit(LIMIT, T0 + MIN);
		noteProviderLimit(LIMIT, T0 + 10 * MIN);
		noteProviderLimit(LIMIT, T0 + 29 * MIN);
		// The pause still ends at the first hit's end: nothing was extended.
		assert.equal(providerPauseStatus(T0 + 29 * MIN).pausedUntil, new Date(T0 + 30 * MIN).toISOString());
		// The next hit, after expiry, is the second consecutive one: 60 minutes, not 90 or more.
		noteProviderLimit(LIMIT, T0 + 30 * MIN);
		assert.equal(providerPauseStatus(T0 + 30 * MIN).pausedUntil, new Date(T0 + 90 * MIN).toISOString());
	});
	it("consecutive episodes double up to the 6 hour cap", () => {
		let now = T0;
		const lengths: number[] = [];
		for (let i = 0; i < 6; i++) {
			noteProviderLimit(LIMIT, now);
			const until = providerPauseStatus(now).pausedUntil!;
			lengths.push((Date.parse(until) - now) / MIN);
			now = Date.parse(until);
		}
		assert.deepEqual(lengths, [30, 60, 120, 240, 360, 360]);
	});
	it("a successful model call resets the backoff to the first step", () => {
		noteProviderLimit(LIMIT, T0);
		noteProviderLimit(LIMIT, T0 + 30 * MIN); // second hit: 60 min
		noteProviderSuccess();
		const after = T0 + 90 * MIN + 60 * MIN;
		noteProviderLimit(LIMIT, after);
		assert.equal(providerPauseStatus(after).pausedUntil, new Date(after + 30 * MIN).toISOString());
	});
});

describe("the pause state keeps no raw provider text", () => {
	it("a canary in the provider text never reaches the status or the gate view", () => {
		noteProviderLimit(`${LIMIT} ${CANARY}`, T0);
		const serialized = JSON.stringify(providerPauseStatus(T0));
		assert.equal(serialized.includes("CANARY"), false);
		assert.equal(serialized.includes("sk-"), false);
		assert.equal(serialized.includes("leak.example"), false);
		assert.equal(providerPauseStatus(T0).message, PROVIDER_LIMIT_MESSAGE);
	});
});

describe("observedEngine: call outcomes feed the pause", () => {
	it("a provider limit in the stream's final error pauses; the consumer still gets the error", async () => {
		const engine = observedEngine(engineWith(() => streamEnding(assistant("error", LIMIT))));
		const stream = engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream;
		const final = await stream.result();
		assert.equal(final.stopReason, "error");
		assert.equal(final.errorMessage, LIMIT, "the call's outcome is unchanged");
		await new Promise((r) => setImmediate(r));
		assert.equal(providerPauseStatus(Date.now()).paused, true);
	});
	it("a completed call is a success: the next limit after it starts the backoff again", async () => {
		const anchor = Date.now();
		noteProviderLimit(LIMIT, anchor - 2 * 60 * MIN); // first hit, ended long ago: hits = 1
		noteProviderLimit(LIMIT, anchor - 90 * MIN); // the first pause ended at -90 min, so this is hit 2 (60 min)
		const engine = observedEngine(engineWith(() => streamEnding(assistant("stop"))));
		await (engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream).result();
		await new Promise((r) => setImmediate(r));
		noteProviderLimit(LIMIT, anchor); // hits reset by the success: 30 minutes, not the 90 that hit 3 would give
		assert.equal(providerPauseStatus(anchor).pausedUntil, new Date(anchor + 30 * MIN).toISOString());
	});
	it("an ordinary error that is not a limit does not pause", async () => {
		const engine = observedEngine(engineWith(() => streamEnding(assistant("error", "context length exceeded"))));
		await (engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream).result();
		await new Promise((r) => setImmediate(r));
		assert.equal(providerPauseStatus(Date.now()).paused, false);
	});
	it("an aborted call neither pauses nor counts as a success", async () => {
		const observed: string[] = [];
		const engine = withProviderLimitObserver(engineWith(() => streamEnding(assistant("aborted", LIMIT))), {
			onProviderLimit: (m) => observed.push(`limit:${m}`),
			onProviderSuccess: () => observed.push("success"),
		});
		await (engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream).result();
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(observed, []);
	});
	it("a throwing observer never changes the call's outcome", async () => {
		const engine = withProviderLimitObserver(engineWith(() => streamEnding(assistant("stop"))), {
			onProviderLimit: () => undefined,
			onProviderSuccess: () => {
				throw new Error("observer broke");
			},
		});
		const final = await (engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream).result();
		assert.equal(final.stopReason, "stop");
	});
	it("one failing call is observed once, even when several consumers read its result", async () => {
		let calls = 0;
		const engine = withProviderLimitObserver(engineWith(() => streamEnding(assistant("error", LIMIT))), {
			onProviderLimit: () => void calls++,
			onProviderSuccess: () => undefined,
		});
		const stream = engine.streamFn({} as never, {} as never, {} as never) as AssistantMessageEventStream;
		await Promise.all([stream.result(), stream.result()]);
		await new Promise((r) => setImmediate(r));
		assert.equal(calls, 1);
	});
});
