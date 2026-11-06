// src/core/ext/mcp/errors.ts
/**
 * The error vocabulary of the read-only MCP server (REQ-mcp-03, REQ-mcp-10).
 * A ToolError carries a code from a closed list and a FIXED-TEXT message: it
 * never embeds a path, a stack or a raw exception message. `failureOf` is the
 * only way an error leaves the server: a ToolError keeps its code and message,
 * anything else becomes the generic `internal` failure (the caller logs the
 * real error on stderr).
 */

export type ToolErrorCode =
	| "invalid_input"
	| "not_found"
	| "disabled"
	| "data_newer_than_build"
	| "data_too_large"
	| "data_inconsistent"
	| "response_too_large"
	| "internal";

export class ToolError extends Error {
	readonly code: ToolErrorCode;
	constructor(code: ToolErrorCode, message: string) {
		super(message);
		this.name = "ToolError";
		this.code = code;
	}
}

export interface ToolFailure {
	error: { code: ToolErrorCode; message: string };
}

export const INTERNAL_MESSAGE = "The server could not complete this request.";
export const NEWER_FORMAT_MESSAGE =
	"The learning data was written by a newer version of the app than this server understands. Update the server before reading it.";

export function failureOf(error: unknown): ToolFailure {
	if (error instanceof ToolError) return { error: { code: error.code, message: error.message } };
	return { error: { code: "internal", message: INTERNAL_MESSAGE } };
}

export const invalid = (message: string): ToolError => new ToolError("invalid_input", message);
