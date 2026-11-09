// src/server/ext/exams-live.ts
/**
 * Composition of exam training (REQ-ex-01..05): the live exams store, the text reader, a
 * private temp copy of each upload, and the cheap-tier splitter behind the shared cost gate.
 * Only wiring: the logic is in exams-service.ts. Routes reach this through the ext barrel.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createExerciseSplitter } from "../../agent/ext/exams/exercise-splitter.ts";
import { readDocumentPages } from "../../agent/ext/study/pdf-pages.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../../core/settings.ts";
import { HttpError } from "./http-error.ts";
import { liveCostGate } from "./cost-live.ts";
import { extractionModelDeps } from "./extraction-deps.ts";
import { createExamsService, ExamsError, type ExamsService, type StagedFile } from "./exams-service.ts";
import { DEFAULT_UPLOAD_TITLE, isPdfUpload, stagePdfUpload, uploadTempRoot } from "./pdf-upload.ts";
import { extStores } from "./stores.ts";
import { keepBytes } from "./workspace.ts";

const modelDeps = extractionModelDeps();

/** The cheap-tier engine for the splitter, read fresh per call; a missing model or key refuses the call. */
const splitter = createExerciseSplitter({
	engine: () => {
		const engine = modelDeps.engineFor("extractor");
		if (engine === undefined) throw new ModelsNotConfiguredError(["cheap"]);
		const provider = engine.model.provider;
		if (modelDeps.providerKeyMissing(provider, "cheap") !== null) throw new ProviderKeyMissingError(provider, ["cheap"]);
		return engine;
	},
	gate: liveCostGate,
});

/** A private copy in the upload temp area, created with owner-only permissions; removed on release. */
async function stageInTemp(bytes: Uint8Array): Promise<StagedFile> {
	const root = uploadTempRoot();
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const dir = await fs.mkdtemp(path.join(root, "upload-"));
	const file = path.join(dir, `${randomUUID()}.pdf`);
	const release = () => fs.rm(dir, { recursive: true, force: true }).then(() => undefined, () => undefined);
	try {
		await fs.writeFile(file, bytes, { mode: 0o600 });
	} catch {
		await release();
		throw new HttpError(500, "the upload could not be stored; try again");
	}
	return { path: file, release };
}

// One service per process, kept on globalThis like study-live.ts does.
const examsHolder = globalThis as unknown as { __lhExams?: ExamsService };
export const examsService: ExamsService = (examsHolder.__lhExams ??= createExamsService({
	store: extStores.examsStore,
	files: extStores.documentFiles,
	stage: stageInTemp,
	readPages: readDocumentPages,
	splitter,
}));

/**
 * A multipart upload (one `file`, optional `title`) for a collection's exams or materials. The
 * PDF is checked and staged by the study upload path (size, %PDF- header, title), then handed to
 * the service as a File; the staged copy is removed whatever happens.
 */
export async function uploadExamPdf(collectionId: string, kind: "exam" | "material", req: Request) {
	if (!isPdfUpload(req)) throw new ExamsError(400, "upload one PDF file as multipart form data");
	const staged = await stagePdfUpload(req);
	try {
		const bytes = new Uint8Array(await fs.readFile(staged.path));
		const file = new File([bytes], "upload.pdf", { type: "application/pdf" });
		const title = staged.title === DEFAULT_UPLOAD_TITLE ? undefined : staged.title;
		// The app keeps its own copy of what the learner uploads (the agent's workspace).
		keepBytes(bytes, `${kind === "exam" ? "exams" : "material"}/${collectionId}`, `${title ?? staged.title}.pdf`);
		return kind === "exam" ? await examsService.addExam(collectionId, file, title) : await examsService.addMaterial(collectionId, file, title);
	} finally {
		await staged.release();
	}
}
