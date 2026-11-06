// src/agent/ext/limit-aware-engine.ts
/**
 * Observes the outcome of every model call an engine makes, without changing
 * what the call returns. A call that ends in an error whose text is a provider
 * limit is reported once; a call that completes is reported as a success.
 *
 * The observer is a pair of injected callbacks: this layer never imports the
 * server's pause state (the composition roots wire it). Observation rides on
 * the stream's own final result, so the consumer sees the same events and the
 * same error in the same order as before. Observer throws are swallowed: a
 * broken observer must never change a model call's outcome.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isProviderLimitMessage } from "../../core/ext/provider-limit.ts";
import type { PiEngine } from "../models.ts";

export interface ProviderLimitObserver {
	/** Called with the provider's own error text, once per failed call that is a usage limit. */
	onProviderLimit(message: string): void;
	/** Called once per call that completed (stop, length or tool use). */
	onProviderSuccess(): void;
}

function observe(message: AssistantMessage, observer: ProviderLimitObserver): void {
	if (message.stopReason === "error") {
		if (isProviderLimitMessage(message.errorMessage)) observer.onProviderLimit(message.errorMessage as string);
		return;
	}
	if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") observer.onProviderSuccess();
}

export function withProviderLimitObserver(engine: PiEngine, observer: ProviderLimitObserver): PiEngine {
	return {
		...engine,
		streamFn: ((model, context, options) => {
			const stream = engine.streamFn(model, context, options);
			if (typeof stream?.result === "function") {
				// The final message is observed before the consumer can see the error: the result promise
				// resolves in the same push that delivers the terminal event.
				stream.result().then(
					(message) => {
						try {
							observe(message, observer);
						} catch {
							/* ignored: the observer never changes the call */
						}
					},
					() => undefined,
				);
			}
			return stream;
		}) as PiEngine["streamFn"],
	};
}
