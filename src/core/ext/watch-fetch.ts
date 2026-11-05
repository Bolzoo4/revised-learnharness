// src/core/ext/watch-fetch.ts
/**
 * The watch's network adapter: fetch a watch entry's feed safely and parse it.
 * Every URL (the entry's and each redirect hop's) passes the host rules of
 * `validateWatchTarget` before it is requested; redirects are followed by hand
 * (max 3, never https to http); the body is read as a stream and abandoned the
 * moment it passes MAX_FEED_BYTES; one timeout bounds the whole exchange; only
 * XML/text content types are accepted. Errors carry fixed messages: no URL,
 * header, stack or network detail. `fetch` is injected (tests, no network).
 */

import { MAX_FEED_BYTES, feedUrl, parseFeed, validateWatchTarget, type FeedItem, type WatchEntry } from "./watch.ts";

export const FEED_TIMEOUT_MS = 30_000;
export const MAX_FEED_REDIRECTS = 3;
const ACCEPT = "application/atom+xml, application/rss+xml, application/xml, text/xml";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FeedFetcherOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
}

const TYPE_OK = /^(?:(?:application|text)\/(?:[\w.-]+\+)?xml|text\/plain)$/;

/** An error of the feed fetch. Its message is always "feed: <fixed reason>": no URL, header or network detail. */
export class FeedError extends Error {
	constructor(message: string) {
		super(`feed: ${message}`);
		this.name = "FeedError";
	}
}

function hostRule(url: string): string | null {
	return validateWatchTarget({ kind: "feed", query: url });
}

/** The declared length, or null when the header is absent or not a plain integer (a malformed value is treated as absent). */
function declaredLength(res: Response): number | null {
	const raw = res.headers.get("content-length");
	return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
}

/** Decodes with the content-type's charset; an unknown or missing charset is utf-8. */
function decoderFor(contentType: string | null): TextDecoder {
	const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
	try {
		return new TextDecoder(m ? m[1]! : "utf-8");
	} catch {
		return new TextDecoder("utf-8");
	}
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
	const declared = declaredLength(res);
	if (declared !== null && declared > maxBytes) {
		await res.body?.cancel().catch(() => {});
		throw new FeedError("response too large");
	}
	if (res.body === null) return "";
	const reader = res.body.getReader();
	// One abort promise and one listener for the whole body; both are removed in `finally`.
	let rejectAborted: (e: Error) => void = () => {};
	const aborted = new Promise<never>((_r, rej) => {
		rejectAborted = rej;
	});
	aborted.catch(() => {}); // settled by the abort below; never an unhandled rejection
	const onAbort = (): void => {
		rejectAborted(new FeedError("timed out"));
		void reader.cancel().catch(() => {});
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) break; // a body that completed is complete, even if the deadline passed in the same tick
			if (signal.aborted) throw new FeedError("timed out");
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new FeedError("response too large");
			}
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	const all = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.byteLength;
	}
	return decoderFor(res.headers.get("content-type")).decode(all);
}

export function createFeedFetcher(options: FeedFetcherOptions = {}): (entry: WatchEntry) => Promise<FeedItem[]> {
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? FEED_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;

	return async (entry) => {
		const reason = validateWatchTarget(entry);
		if (reason !== null) throw new FeedError(reason);
		let url = feedUrl(entry);
		const first = hostRule(url);
		if (first !== null) throw new FeedError(first);
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			for (let hop = 0; ; hop++) {
				let res: Response;
				try {
					res = await doFetch(url, { redirect: "manual", signal, headers: { Accept: ACCEPT } });
				} catch {
					throw new FeedError(signal.aborted ? "timed out" : "request failed");
				}
				if (REDIRECT_STATUSES.has(res.status)) {
					await res.body?.cancel().catch(() => {});
					if (hop >= MAX_FEED_REDIRECTS) throw new FeedError("too many redirects");
					const location = res.headers.get("location");
					if (location === null || location === "") throw new FeedError("redirect without a usable location");
					let next: URL;
					try {
						next = new URL(location, url);
					} catch {
						throw new FeedError("redirect without a usable location");
					}
					if (new URL(url).protocol === "https:" && next.protocol !== "https:") throw new FeedError("redirect refused: https to http");
					if (hostRule(next.href) !== null) throw new FeedError("redirect refused: target is not a public http(s) address");
					url = next.href;
					continue;
				}
				if (!res.ok) {
					await res.body?.cancel().catch(() => {});
					throw new FeedError(`HTTP ${res.status}`);
				}
				const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
				if (!TYPE_OK.test(type)) {
					await res.body?.cancel().catch(() => {});
					throw new FeedError("unsupported content type");
				}
				try {
					return parseFeed(await readCapped(res, maxBytes, signal));
				} catch (e) {
					if (e instanceof FeedError) throw e;
					throw new FeedError(signal.aborted ? "timed out" : "could not read the response");
				}
			}
		} catch (e) {
			if (e instanceof FeedError) throw e;
			throw new FeedError("request failed");
		}
	};
}
