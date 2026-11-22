// scripts/embed-benchmark.ts
/**
 * Benchmark of the embedding models on the owner's real nodes (plan Task 5, step 4). Read-only on the data dir.
 *
 *   npx tsx scripts/embed-benchmark.ts <dataDir> <queriesFile> [--nodes 200] [--cache-dir <dir>]
 *
 * queriesFile: a JSON array of {"query": string, "id": nodeId}, paraphrases of nodes in the sample. It is an
 * input file, never committed. Models load from the cache only (no download). Prints one JSON line per model
 * with recall@1, recall@10, MRR, ms per node, ms per query and the model's size on disk. Never prints node text
 * or query text.
 */

import fs from "node:fs";
import path from "node:path";

import { BGE_M3_SPEC, EMBEDDINGGEMMA_SPEC, topK, type EmbedderSpec } from "../src/core/ext/embedder.ts";
import { indexText } from "../src/core/ext/vector-index.ts";
import { createGraphReader, createReadableGuard, validateDataRoot } from "../src/store/ext/readonly.ts";
import { createTransformersLoader, defaultModelCacheDir } from "../src/server/ext/embedder-transformers.ts";

interface BenchQuery {
	query: string;
	id: string;
}

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function readQueries(file: string): BenchQuery[] {
	const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
	if (!Array.isArray(parsed)) throw new Error("queries file must be a JSON array");
	return parsed.map((row, i) => {
		const r = row as Partial<BenchQuery>;
		if (typeof r?.query !== "string" || typeof r?.id !== "string") throw new Error(`queries[${i}] needs string "query" and "id"`);
		return { query: r.query, id: r.id };
	});
}

function sizeOnDisk(dir: string): number {
	let total = 0;
	if (!fs.existsSync(dir)) return 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		total += entry.isDirectory() ? sizeOnDisk(full) : fs.statSync(full).size;
	}
	return total;
}

async function benchmark(spec: EmbedderSpec, cacheDir: string, texts: string[], nodeIds: string[], queries: BenchQuery[]) {
	const load = await createTransformersLoader(spec, { cacheDir, allowDownload: false })();
	if (!load.ok) return { model: spec.id, skipped: load.reason };
	const embedder = load.embedder;

	await embedder.embed(["warm up"], "document"); // loads the pipeline outside the timing

	const t0 = performance.now();
	const docs = await embedder.embed(texts, "document");
	const msPerNode = (performance.now() - t0) / texts.length;

	const t1 = performance.now();
	const qvecs = await embedder.embed(
		queries.map((q) => q.query),
		"query",
	);
	const msPerQuery = (performance.now() - t1) / queries.length;

	const items = nodeIds.map((id, j) => ({ id, vector: docs[j]! }));
	let recall1 = 0;
	let recall10 = 0;
	let mrr = 0;
	queries.forEach((q, i) => {
		const ranking = topK(qvecs[i]!, items, items.length);
		const rank = ranking.findIndex((r) => r.id === q.id) + 1;
		if (rank === 1) recall1++;
		if (rank >= 1 && rank <= 10) recall10++;
		if (rank >= 1) mrr += 1 / rank;
	});
	const n = queries.length;
	return {
		model: spec.id,
		dim: spec.dim,
		pooling: spec.pooling,
		nodes: texts.length,
		queries: n,
		msPerNode: +msPerNode.toFixed(1),
		msPerQuery: +msPerQuery.toFixed(1),
		recall1: +(recall1 / n).toFixed(3),
		recall10: +(recall10 / n).toFixed(3),
		mrr: +(mrr / n).toFixed(3),
		cachedBytes: sizeOnDisk(path.join(cacheDir, spec.id)),
	};
}

async function main(): Promise<void> {
	const valued = new Set(["--nodes", "--cache-dir"]);
	const positional: string[] = [];
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i]!;
		if (valued.has(arg)) i++;
		else if (!arg.startsWith("--")) positional.push(arg);
	}
	const [dataDir, queriesFile] = positional;
	if (!dataDir || !queriesFile) {
		console.error("usage: npx tsx scripts/embed-benchmark.ts <dataDir> <queriesFile> [--nodes 200] [--cache-dir <dir>]");
		process.exit(2);
	}
	const sampleSize = Number(argValue("--nodes") ?? 200);
	const cacheDir = argValue("--cache-dir") ?? defaultModelCacheDir();

	validateDataRoot(dataDir);
	createReadableGuard(dataDir)();
	const nodes = createGraphReader(path.join(dataDir, "graph")).readNodes().slice(0, sampleSize);
	const sampleIds = new Set(nodes.map((n) => n.id));
	const queries = readQueries(queriesFile).filter((q) => sampleIds.has(q.id));
	if (nodes.length === 0 || queries.length === 0) throw new Error("no nodes or no queries inside the sample");

	const texts = nodes.map((n) => indexText(n));
	const nodeIds = nodes.map((n) => n.id);
	for (const spec of [EMBEDDINGGEMMA_SPEC, BGE_M3_SPEC]) {
		try {
			console.log(JSON.stringify(await benchmark(spec, cacheDir, texts, nodeIds, queries)));
		} catch (error) {
			console.log(JSON.stringify({ model: spec.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
		}
	}
}

main().catch((error: unknown) => {
	console.error(`embed-benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
