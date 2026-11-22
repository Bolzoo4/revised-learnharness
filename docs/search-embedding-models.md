# Embedding models: what is verified and what is not

Status as of 2026-11-23. Scope: the Transformers.js adapter (`src/server/ext/embedder-transformers.ts`) and the default
model. The research notes and the first benchmark table are in the planning repo (`Learning_system/docs/search-embedding-models.md`).

## Default model: `onnx-community/embeddinggemma-300m-ONNX`, q8

| Item | Status | Evidence |
|---|---|---|
| Output dimension 768 | Verified from file | `config.json` in the model cache: `hidden_size: 768`, architecture `Gemma3TextModel`. |
| Quantised weights are `onnx/model_quantized.onnx` plus `onnx/model_quantized.onnx_data` (external data) | Verified from files | Cache listing. The `_data` file is about 295 MB. The adapter checks the main file, the download script lists both. |
| Pooling is applied by the pipeline, not by the graph | Verified by running | Smoke run with `pooling: "none"` returns token states `[1, 5, 768]` for "ciao mondo". |
| `mean` pooling is the right choice | Unverified | The model card and a sentence-transformers `1_Pooling` config are not in the cache. The benchmark used `mean` from memory. |
| Output is unit length with `normalize: true` | Verified by running | Smoke run: norm 1.000000, length 768. |
| Query template `task: search result \| query: ` | Unverified | Taken from memory of the model card. Check against the card. |
| Document template `title: none \| text: ` | Unverified | Taken from memory of the model card. Check against the card. |
| Licence (Gemma Terms) allows downloading the model into an AGPL-3.0 app | To be reviewed by a human | Not checked in this work. |

Download size (from the Hub, `scripts/embed-download.ts` without `--yes`): about 315 MB in total (`tokenizer.json` 19 MB, weights 295 MB, the rest small).

## Fallback model: `Xenova/bge-m3`, q8

| Item | Status | Evidence |
|---|---|---|
| Output dimension 1024 | Verified from file | `config.json`: `hidden_size: 1024`, `XLMRobertaModel`. |
| Loads and embeds through the adapter | Verified by running | Benchmark smoke run on 3 synthetic nodes with `cls` pooling. |
| `cls` pooling | Unverified | No `1_Pooling` or `modules.json` in the cache. |
| No prefixes | Unverified | Taken from memory of the model card. |

On-disk size of the cached model: about 587 MB.

## Adapter behaviour (verified by tests and by a manual run)

- Downloads are off by default. With the model files absent from `<data dir>/ext/models`, the loader returns
  `unavailable: model not downloaded` and calls no network or pipeline code (unit tests with an injected factory).
- The pipeline is loaded with `local_files_only: true` unless the owner's download command runs.
- The pipeline loads once per process and is kept. A failed load is retried on the next call.
- Manual run, 2026-11-23, cached Gemma model, 768-dim unit vector for "ciao mondo" (document template).

## Open items before the first release

1. A human reads the Gemma Terms and records whether downloading the model into the app is allowed.
2. Check both query/document templates and both poolings against the model cards, and re-run `scripts/embed-benchmark.ts` if they differ.
