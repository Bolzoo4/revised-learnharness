// src/server/ext/embedder-wasm.ts
/**
 * The extractor the app runs: the ONNX model on onnxruntime-web's WASM backend, tokenised with
 * @huggingface/tokenizers. It does not use onnxruntime-node, whose native binding aborts the whole
 * process inside Electron's V8 (checked 2026-11-23), nor @huggingface/transformers. It reads the
 * model files already in the cache and never touches the network.
 */

import fs from "node:fs";
import path from "node:path";
import type { Extractor, ExtractorFactory } from "./embedder-transformers.ts";

const MAX_TOKENS = 512;

/** Mean over the real (unmasked) tokens of a [tokens x dim] block, then L2-normalised. Pure. */
export function meanPoolNormalize(hidden: ArrayLike<number>, mask: ArrayLike<number | bigint>, dim: number): Float32Array {
	const out = new Float32Array(dim);
	let count = 0;
	for (let t = 0; t < mask.length; t++) {
		if (Number(mask[t]) === 0) continue;
		count++;
		const base = t * dim;
		for (let d = 0; d < dim; d++) out[d] = out[d]! + Number(hidden[base + d]);
	}
	if (count === 0) throw new Error("no tokens to pool");
	return l2Normalize(out.map((v) => v / count));
}

/** First-token (CLS) vector, L2-normalised. Pure. */
export function clsNormalize(hidden: ArrayLike<number>, dim: number): Float32Array {
	return l2Normalize(Float32Array.from({ length: dim }, (_, d) => Number(hidden[d])));
}

function l2Normalize(vector: Float32Array): Float32Array {
	let sum = 0;
	for (const v of vector) sum += v * v;
	const norm = Math.sqrt(sum);
	return norm === 0 ? vector : vector.map((v) => v / norm);
}

/** Loads the model from `<cacheDir>/<modelId>` (local files only). */
export const loadWasmExtractor: ExtractorFactory = async (modelId, { cacheDir }): Promise<Extractor> => {
	const root = path.join(cacheDir, modelId);
	const ort = await import("onnxruntime-web");
	const { Tokenizer } = await import("@huggingface/tokenizers");
	const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;
	const tokenizer = new Tokenizer(readJson("tokenizer.json"), readJson("tokenizer_config.json"));

	const weights = path.join(root, "onnx", "model_quantized.onnx");
	const dataFile = `${weights}_data`;
	const session = await ort.InferenceSession.create(weights, {
		executionProviders: ["wasm"],
		...(fs.existsSync(dataFile) ? { externalData: [{ path: path.basename(dataFile), data: new Uint8Array(fs.readFileSync(dataFile)) }] } : {}),
	});

	return async (text, { pooling }) => {
		const encoded = tokenizer.encode(text);
		const ids = encoded.ids.slice(0, MAX_TOKENS);
		const mask = encoded.attention_mask.slice(0, MAX_TOKENS);
		const feeds = {
			input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map((id: number) => BigInt(id))), [1, ids.length]),
			attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map((m: number) => BigInt(m))), [1, mask.length]),
		};
		const out = await session.run(feeds);
		const hidden = out.last_hidden_state;
		if (hidden === undefined) throw new Error("the model has no last_hidden_state output");
		const dim = hidden.dims[hidden.dims.length - 1]!;
		const data = hidden.data as Float32Array;
		return { data: pooling === "cls" ? clsNormalize(data, dim) : meanPoolNormalize(data, mask, dim) };
	};
};
