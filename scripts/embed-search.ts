/**
 * Try the semantic index from the terminal (plain Node; the desktop runtime cannot run the model yet).
 *   LH_DATA_DIR=<data dir> npx tsx scripts/embed-search.ts "your query" [--top 5]
 * Read-only: embeds the query with the downloaded model and ranks the nodes in ext/embeddings.bin.
 */
import path from "node:path";
import { DEFAULT_EMBEDDER_SPEC } from "../src/core/ext/embedder.ts";
import { rankIndex } from "../src/core/ext/vector-index.ts";
import { createTransformersLoader } from "../src/server/ext/embedder-transformers.ts";
import { readVectorIndex, vectorIndexPath } from "../src/server/ext/vector-index-store.ts";
import { EXT_PATHS } from "../src/store/ext/paths.ts";
import { stores } from "../src/server/stores.ts";

const args = process.argv.slice(2);
const topIdx = args.indexOf("--top");
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 5;
const query = args.filter((a, i) => !a.startsWith("--") && i !== topIdx + 1).join(" ").trim();
if (query === "") {
	console.error('usage: embed-search.ts "query" [--top N]');
	process.exit(2);
}
const index = readVectorIndex(vectorIndexPath(path.dirname(EXT_PATHS.dir)));
if (index === null) {
	console.error("no index yet (ext/embeddings.bin)");
	process.exit(1);
}
const load = await createTransformersLoader(DEFAULT_EMBEDDER_SPEC)();
if (!load.ok) {
	console.error(load.reason);
	process.exit(1);
}
const [vector] = await load.embedder.embed([query], "query");
const names = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
for (const hit of rankIndex(index, vector!).slice(0, top)) {
	const n = names.get(hit.id);
	console.log(`${hit.score.toFixed(3)}  ${n?.name ?? hit.id}  —  ${(n?.statement ?? "").slice(0, 110)}`);
}
process.exit(0);
