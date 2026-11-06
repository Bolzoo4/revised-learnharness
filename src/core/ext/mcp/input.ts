// src/core/ext/mcp/input.ts
/**
 * Validation of tool arguments. The SDK layer validates the same shapes with
 * zod; these functions are the second, independent check (the core is called
 * directly by tests and must never trust its caller): ids and queries are
 * bounded strings without control characters, enums are closed, dates are real
 * calendar dates, instants carry an explicit zone.
 */

import { invalid } from "./errors.ts";
import { LIMITS } from "./limits.ts";

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_G = /[\u0000-\u001f\u007f]+/g;

export function requireText(value: unknown, field: string, maxChars: number): string {
	if (typeof value !== "string") throw invalid(`${field} must be a string.`);
	if (value.trim() === "") throw invalid(`${field} must not be empty.`);
	if (value.length > maxChars) throw invalid(`${field} must be at most ${maxChars} characters.`);
	if (CONTROL.test(value)) throw invalid(`${field} must not contain control characters.`);
	return value;
}

export const requireId = (value: unknown, field: string): string => requireText(value, field, LIMITS.idMaxChars);

/** A search query: control characters count as spaces, whitespace is collapsed. */
export function requireQuery(value: unknown): string {
	if (typeof value !== "string") throw invalid("query must be a string.");
	if (value.length > LIMITS.queryMaxChars) throw invalid(`query must be at most ${LIMITS.queryMaxChars} characters.`);
	const query = value.replace(CONTROL_G, " ").replace(/\s+/g, " ").trim();
	if (query === "") throw invalid("query must not be empty.");
	if (query.split(" ").length > LIMITS.queryMaxTokens) throw invalid(`query must have at most ${LIMITS.queryMaxTokens} words.`);
	return query;
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw invalid(`${field} must be one of: ${allowed.join(", ")}.`);
	}
	return value as T;
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw invalid(`${field} must be an integer from ${min} to ${max}.`);
	}
	return value;
}

export function parseDepth(value: unknown): 1 | 2 {
	if (value === undefined) return 1;
	if (value === 1 || value === 2) return value;
	throw invalid("depth must be 1 or 2.");
}

export interface LocalDate {
	year: number;
	month: number;
	day: number;
	iso: string;
}

/** YYYY-MM-DD naming a real calendar date (2026-02-30 and years below 100 are refused). */
export function parseLocalDate(value: unknown, field: string): LocalDate {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`${field} must be a date as YYYY-MM-DD.`);
	const [year, month, day] = value.split("-").map(Number) as [number, number, number];
	const probe = new Date(year, month - 1, day, 12);
	if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
		throw invalid(`${field} is not a calendar date.`);
	}
	return { year, month, day, iso: value };
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO-8601 instant WITH an explicit zone; returned normalised to UTC. The date part must be a real calendar date. */
export function parseInstant(value: unknown, field: string): string {
	if (typeof value !== "string" || !INSTANT.test(value)) throw invalid(`${field} must be an ISO-8601 instant with a zone, e.g. 2026-11-04T10:00:00Z.`);
	parseLocalDate(value.slice(0, 10), field); // Date.parse rolls 2026-02-30 over to March: refuse it first
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw invalid(`${field} is not a valid instant.`);
	return new Date(ms).toISOString();
}

/** Milliseconds of an ISO string; -Infinity when unparseable (so it sorts oldest, never NaN). */
export function instantMs(iso: string): number {
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The arguments object: absent means {}, anything but a plain object is refused. */
export function plainObject(input: unknown): Record<string, unknown> {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object" || Array.isArray(input)) throw invalid("The arguments must be a JSON object.");
	return input as Record<string, unknown>;
}
