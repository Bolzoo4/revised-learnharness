// src/server/ext/embedder-transformers.ts
/**
 * The Transformers.js adapter of the embedding port (REQ-search-06). The pipeline loads lazily, on the first
 * embed, and is kept. Downloads are off unless the owner's download command asks for them
 * (scripts/embed-download.ts): with downloads off and the model files absent from the cache, the adapter
 * refuses with MODEL_UNAVAILABLE and never touches the network.
 *
 * The model files live in `<data dir>/ext/models/<model id>/` (the Transformers.js cache layout).
 */

import fs from "node:fs";
import path from "node:path";

import {
	applyPrefix,
	checkEmbedderSpec,
	MODEL_UNAVAILABLE,
	type EmbedKind,
	type Embedder,
	type EmbedderLoad,
	type EmbedderSpec,
} from "../../core/ext/embedder.ts";
import { EXT_PATHS } from "../../store/ext/paths.ts";

/** The quantised weights for dtype q8 (the name Transformers.js uses). */
export const MODEL_WEIGHTS_FILE = "onnx/model_quantized.onnx";

/** Files a usable model needs in the cache. */
export const REQUIRED_MODEL_FILES: readonly string[] = ["config.json", "tokenizer.json", "tokenizer_config.json", MODEL_WEIGHTS_FILE];

/** The default cache: <data dir>/ext/models. */
export function defaultModelCacheDir(): string {
	return path.join(EXT_PATHS.dir, "models");
}

/** The required files that are not in the cache yet (empty when the model is complete). Reads the disk only. */
export function missingModelFiles(spec: EmbedderSpec, cacheDir: string): string[] {
	return REQUIRED_MODEL_FILES.filter((file) => !fs.existsSync(path.join(cacheDir, spec.id, file)));
}

/** One text in, one raw vector out (the pipeline's own call shape). */
export type Extractor = (text: string, options: { pooling: "mean" | "cls"; normalize: true }) => Promise<{ data: ArrayLike<number> }>;

export interface ExtractorRequest {
	cacheDir: string;
	allowDownload: boolean;
}

/** Builds the extractor for a model id. The default one loads @huggingface/transformers. */
export type ExtractorFactory = (modelId: string, request: ExtractorRequest) => Promise<Extractor>;

export interface TransformersOptions {
	/** Model cache directory. Default: defaultModelCacheDir(). */
	cacheDir?: string;
	/** Allow the pipeline to download missing files. Default false. */
	allowDownload?: boolean;
	/** Test seam: the Electron version string, or undefined for plain Node. Default: process.versions.electron. */
	electronVersion?: string | undefined;
	/** Replaces the real pipeline (tests). */
	factory?: ExtractorFactory;
}

/** The real pipeline. Per-call options only: no global library state is changed. */
const loadPipeline: ExtractorFactory = async (modelId, { cacheDir, allowDownload }) => {
	const lib = await import("@huggingface/transformers");
	const build = lib.pipeline as unknown as (
		task: "feature-extraction",
		model: string,
		options: { dtype: "q8"; cache_dir: string; local_files_only: boolean },
	) => Promise<unknown>;
	const extractor = await build("feature-extraction", modelId, {
		dtype: "q8",
		cache_dir: cacheDir,
		local_files_only: !allowDownload,
	});
	return extractor as Extractor;
};

/** A lazy embedder for the spec. Throws on construction only for an invalid spec. */
export function createTransformersEmbedder(spec: EmbedderSpec, options: TransformersOptions = {}): Embedder {
	const problems = checkEmbedderSpec(spec);
	if (problems.length > 0) throw new RangeError(`invalid embedder spec: ${problems.join("; ")}`);
	const cacheDir = options.cacheDir ?? defaultModelCacheDir();
	const allowDownload = options.allowDownload ?? false;
	const factory = options.factory ?? loadPipeline;

	let pending: Promise<Extractor> | null = null;

	function ready(): Promise<Extractor> {
		if (pending === null) {
			if (!allowDownload && missingModelFiles(spec, cacheDir).length > 0) {
				return Promise.reject(new Error(MODEL_UNAVAILABLE));
			}
			pending = factory(spec.id, { cacheDir, allowDownload }).catch((error: unknown) => {
				pending = null;
				throw error;
			});
		}
		return pending;
	}

	return {
		spec,
		async embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]> {
			const extract = await ready();
			const out: Float32Array[] = [];
			for (const text of texts) {
				const result = await extract(applyPrefix(spec, text, kind), { pooling: spec.pooling, normalize: true });
				const vector = Float32Array.from(result.data);
				if (vector.length !== spec.dim) {
					throw new Error(`model returned ${vector.length} values, expected ${spec.dim}`);
				}
				out.push(vector);
			}
			return out;
		},
	};
}

/**
 * The loader the app's index uses. Before the model files are present it answers MODEL_UNAVAILABLE (a
 * refresh records the reason and writes nothing). Once they are present it returns one embedder for the life
 * of the process. No network is touched unless `allowDownload` is set.
 */
export const ELECTRON_UNAVAILABLE = "unavailable: the local embedder does not run inside the desktop runtime yet";

export function createTransformersLoader(spec: EmbedderSpec, options: TransformersOptions = {}): () => Promise<EmbedderLoad> {
	const cacheDir = options.cacheDir ?? defaultModelCacheDir();
	const allowDownload = options.allowDownload ?? false;
	let embedder: Embedder | null = null;
	const electron = "electronVersion" in options ? options.electronVersion : process.versions.electron;
	return async () => {
		if (embedder !== null) return { ok: true, embedder };
		// onnxruntime-node aborts the whole process (SIGTRAP) on its first inference inside Electron's V8
		// (checked 2026-11-23 with the packaged runtime): refuse instead of taking the service down.
		if (options.factory === undefined && electron !== undefined) return { ok: false, reason: ELECTRON_UNAVAILABLE };
		if (!allowDownload && missingModelFiles(spec, cacheDir).length > 0) {
			return { ok: false, reason: MODEL_UNAVAILABLE };
		}
		embedder = createTransformersEmbedder(spec, { ...options, cacheDir, allowDownload });
		return { ok: true, embedder };
	};
}
