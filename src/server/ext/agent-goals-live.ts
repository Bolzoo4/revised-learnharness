// src/server/ext/agent-goals-live.ts
/**
 * Live wiring of the study agent's endpoints (agent-goals.ts): the shared stores, the agent cost kind,
 * and the PDF import. Only wiring; the logic is in agent-goals.ts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readDocumentPages } from "../../agent/ext/study/pdf-pages.ts";
import { emit } from "../../core/events.ts";
import { sourceDirectory } from "../source-organization.ts";
import { stores } from "../stores.ts";
import { liveAgentGate } from "./cost-live.ts";
import { type AgentGoalInput, type AgentGoalsDeps, type AgentResult, createAgentGoal, createAgentLink, setAgentGoalWeights } from "./agent-goals.ts";
import { DEFAULT_UPLOAD_TITLE, uploadTempRoot } from "./pdf-upload.ts";
import { extStores } from "./stores.ts";
import { sourceIdOf, studyService } from "./study-live.ts";

/**
 * Stores an attached PDF exactly as a user upload is stored (studyService.registerDocument), then runs the
 * notes extraction on the stored copy so its nodes carry that copy's src_ provenance (REQ-graph-agent-12).
 */
async function importAgentPdf(bytes: Uint8Array): Promise<{ sourceId: string }> {
	const root = uploadTempRoot();
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const dir = await fs.mkdtemp(path.join(root, "upload-"));
	try {
		const staged = path.join(dir, "agent-attachment.pdf");
		await fs.writeFile(staged, bytes, { mode: 0o600 });
		const document = await studyService.registerDocument({ path: staged, title: DEFAULT_UPLOAD_TITLE });
		const storedPath = studyService.pdfFile(document.id);
		const { pages } = await readDocumentPages(storedPath);
		const { extraction } = await import("../chat-handler.ts");
		sourceDirectory.registerImport(storedPath);
		try {
			await extraction.importNotes({ filePath: storedPath, text: pages.join("\n\n") });
		} finally {
			emit("sources-changed", {});
		}
		return { sourceId: sourceIdOf(storedPath) };
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Built per call, so the stores and the gate are read fresh. */
function liveDeps(): AgentGoalsDeps {
	return {
		graphStore: stores.graphStore,
		goalsStore: extStores.goalsStore,
		linksStore: extStores.linksStore,
		gate: liveAgentGate,
		documents: { importPdf: importAgentPdf },
	};
}

export const agentGoals = {
	create: (input: AgentGoalInput) => createAgentGoal(input, liveDeps()),
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
