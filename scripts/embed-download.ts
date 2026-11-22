// scripts/embed-download.ts
/**
 * Downloads the default embedding model into the model cache. An owner's command: the app and the tests never
 * download. Without --yes it only prints the files and their sizes.
 *
 *   npx tsx scripts/embed-download.ts                 list files and sizes, download nothing
 *   npx tsx scripts/embed-download.ts --yes           download, then embed one text to prove the model loads
 *   npx tsx scripts/embed-download.ts --cache-dir <d> use another cache directory (default: <data dir>/ext/models)
 */

import { DEFAULT_EMBEDDER_SPEC } from "../src/core/ext/embedder.ts";
import {
	createTransformersEmbedder,
	defaultModelCacheDir,
	MODEL_WEIGHTS_FILE,
	missingModelFiles,
	REQUIRED_MODEL_FILES,
} from "../src/server/ext/embedder-transformers.ts";

/** Weights kept in a separate file for the quantised graph (EmbeddingGemma has one; others may not). */
const OPTIONAL_MODEL_FILES: readonly string[] = [`${MODEL_WEIGHTS_FILE}_data`];

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Size in bytes from the Hub (the final CDN response). Null when the file does not exist for this model; 0 when the size is not given. */
async function remoteSize(modelId: string, file: string): Promise<number | null> {
	const res = await fetch(`https://huggingface.co/${modelId}/resolve/main/${file}`, { method: "HEAD", redirect: "follow" });
	if (!res.ok) return null;
	return Number(res.headers.get("x-linked-size") ?? res.headers.get("content-length") ?? 0);
}

function mb(bytes: number): string {
	return bytes === 0 ? "size not given" : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
	const cacheDir = argValue("--cache-dir") ?? defaultModelCacheDir();
	const spec = DEFAULT_EMBEDDER_SPEC;
	const files = [...REQUIRED_MODEL_FILES, ...OPTIONAL_MODEL_FILES];
	const sizes = await Promise.all(files.map((file) => remoteSize(spec.id, file)));

	console.log(`Model:  ${spec.id} (dtype q8, ${spec.dim} dimensions)`);
	console.log(`Cache:  ${cacheDir}`);
	files.forEach((file, i) => {
		const size = sizes[i];
		if (size === null || size === undefined) return;
		console.log(`  ${file.padEnd(40)} ${mb(size)}`);
	});
	const total = sizes.reduce((sum: number, n) => sum + (n ?? 0), 0);
	console.log(`Total download: ${mb(total)}`);

	if (!process.argv.includes("--yes")) {
		console.log("Nothing downloaded. Re-run with --yes to download the model.");
		return;
	}

	const embedder = createTransformersEmbedder(spec, { cacheDir, allowDownload: true });
	const [vector] = await embedder.embed(["test"], "document");
	const missing = missingModelFiles(spec, cacheDir);
	if (missing.length > 0) throw new Error(`files still missing after download: ${missing.join(", ")}`);
	console.log(`Ready: ${vector!.length} values per vector.`);
}

main().catch((error: unknown) => {
	console.error(`embed-download failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
