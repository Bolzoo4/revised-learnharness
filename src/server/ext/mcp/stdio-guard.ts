// src/server/ext/mcp/stdio-guard.ts
/**
 * Stdout belongs to the protocol (REQ-mcp-01). Any stray console.log, library
 * warning or debug print on stdout would corrupt the JSON-RPC stream, so:
 *   - process.stdout.write and console.log/info/debug are redirected to stderr;
 *   - the transport gets a dedicated Writable that writes to the REAL stdout.
 * A closed stdout (EPIPE, or any other stdout error) ends the process quietly
 * through onClosed: no unhandled 'error' event and no stack on stderr.
 */

import { Writable } from "node:stream";

export interface StdioGuard {
	/** Hand this to StdioServerTransport as its output stream. */
	protocolOut: Writable;
	restore(): void;
}

export function installStdioGuard(proc: NodeJS.Process = process, onClosed: () => void = () => proc.exit(0)): StdioGuard {
	const realWrite = proc.stdout.write.bind(proc.stdout) as (chunk: string | Uint8Array, cb?: (err?: Error | null) => void) => boolean;
	const toStderr = (chunk: string | Uint8Array, cb?: unknown): boolean =>
		proc.stderr.write(chunk, typeof cb === "function" ? (cb as (err?: Error | null) => void) : undefined);

	const originalWrite = proc.stdout.write;
	proc.stdout.write = ((chunk: string | Uint8Array, cb?: unknown) => toStderr(chunk, cb)) as typeof proc.stdout.write;

	const originals = { log: console.log, info: console.info, debug: console.debug };
	const redirect =
		(prefix: string) =>
		(...args: unknown[]): void => {
			proc.stderr.write(`${prefix}${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
		};
	console.log = redirect("");
	console.info = redirect("");
	console.debug = redirect("");

	// Any stdout failure means the client can no longer receive replies: end quietly.
	proc.stdout.on("error", () => onClosed());

	// The transport's writes never surface an error event: a failed write ends the process (via onClosed).
	const protocolOut = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			realWrite(chunk, (err) => {
				if (err) onClosed();
				callback();
			});
		},
	});

	return {
		protocolOut,
		restore() {
			proc.stdout.write = originalWrite;
			console.log = originals.log;
			console.info = originals.info;
			console.debug = originals.debug;
		},
	};
}
