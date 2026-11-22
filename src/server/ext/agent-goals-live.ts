// src/server/ext/agent-goals-live.ts
/**
 * Live wiring of the study agent's endpoints (agent-goals.ts): the shared stores, the agent cost kind,
 * and the PDF import. Only wiring; the logic is in agent-goals.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readDocumentPages } from "../../agent/ext/study/pdf-pages.ts";
import { type AttachmentPorts, importAttachedPdf } from "./agent-attachment.ts";
import { emit } from "../../core/events.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveAgentGate } from "./cost-live.ts";
import { type AgentGoalInput, type AgentGoalsDeps, type AgentResult, createAgentGoal, createAgentLink, readAgentSandbox, setAgentGoalWeights } from "./agent-goals.ts";
import { DEFAULT_UPLOAD_TITLE, uploadTempRoot } from "./pdf-upload.ts";
import { liveSandbox } from "./sandbox-live.ts";
import { extStores } from "./stores.ts";
import { sourceIdOf, studyService } from "./study-live.ts";

/**
 * The live ports of an attached PDF: a private staged copy, the document store a user upload goes through
 * (studyService.registerDocument), and the notes extraction on the stored copy (REQ-graph-agent-12, REQ-02 page
 * anchors via agent-attachment.ts). The sandbox file itself stays where it is (REQ-graph-agent-25).
 */
const attachmentPorts: AttachmentPorts = {
	async stageCopy(bytes) {
		const root = uploadTempRoot();
		await fs.mkdir(root, { recursive: true, mode: 0o700 });
		const dir = await fs.mkdtemp(path.join(root, "upload-"));
		const file = path.join(dir, "agent-attachment.pdf");
		await fs.writeFile(file, bytes, { mode: 0o600 });
		return { path: file, release: () => fs.rm(dir, { recursive: true, force: true }) };
	},
	async storeDocument(stagedPath) {
		const document = await studyService.registerDocument({ path: stagedPath, title: DEFAULT_UPLOAD_TITLE });
		return studyService.pdfFile(document.id);
	},
	async readPages(storedPath) {
		return (await readDocumentPages(storedPath)).pages;
	},
	async importNotes(storedPath, text) {
		const { extraction } = await import("../chat-handler.ts");
		sourceDirectory.registerImport(storedPath);
		try {
			await extraction.importNotes({ filePath: storedPath, text });
		} finally {
			emit("sources-changed", {});
		}
	},
	sourceIdOf,
};

/** Stores an attached PDF exactly as a user upload is stored, then extracts its notes with page anchors. */
function importAgentPdf(bytes: Uint8Array): Promise<{ sourceId: string }> {
	return importAttachedPdf(bytes, attachmentPorts);
}


/** Built per call, so the stores and the gate are read fresh. */
function liveDeps(): AgentGoalsDeps {
	return {
		graphStore: stores.graphStore,
		goalsStore: extStores.goalsStore,
		linksStore: extStores.linksStore,
		gate: liveAgentGate,
		documents: { importPdf: importAgentPdf },
		sandbox: liveSandbox,
	};
}

export const agentGoals = {
	create: (input: AgentGoalInput) => createAgentGoal(input, liveDeps()),
	sandbox: () => readAgentSandbox(liveDeps()),
	setWeights: (goalId: string, raw: unknown) => setAgentGoalWeights(goalId, raw, liveDeps()),
	createLink: (input: { from: unknown; to: unknown; linkType: unknown }) => createAgentLink(input, liveDeps()),
};

/** JSON for a service result: the body on success, { error, problems? } with the service's status on refusal. */
export function agentResponse<T extends object>(result: AgentResult<T>): Response {
	if (!result.ok) {
		return Response.json({ error: result.message, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
	}
	const { ok: _ok, ...body } = result;
	return Response.json(body, { status: 200 });
}
