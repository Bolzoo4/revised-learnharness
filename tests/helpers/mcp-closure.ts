// tests/helpers/mcp-closure.ts
/** Static RUNTIME import closure ("import type" / "export type" statements are erased by the compiler and skipped).
 * Static import closure of an entry file, followed through relative imports (type-only imports included: conservative). */
import fs from "node:fs";
import path from "node:path";

const IMPORT_RE = /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm;

export interface Closure {
	files: string[];
	packages: string[];
}

export function importClosure(entry: string, root: string): Closure {
	const files = new Set<string>();
	const packages = new Set<string>();
	const visit = (file: string): void => {
		if (files.has(file)) return;
		files.add(file);
		const src = fs.readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
		for (const m of src.matchAll(IMPORT_RE)) {
			const spec = m[1] ?? m[2] ?? m[3];
			if (spec === undefined) continue;
			if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec));
			else packages.add(spec);
		}
	};
	visit(path.resolve(root, entry));
	return { files: [...files].map((f) => path.relative(root, f)).sort(), packages: [...packages].sort() };
}
