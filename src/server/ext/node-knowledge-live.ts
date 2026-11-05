// src/server/ext/node-knowledge-live.ts
/**
 * Live wiring of the node-knowledge service: the real stores, the settings-
 * resolved model for the writer, upstream's call pricing and the shared
 * daily cost gate. Nothing here has logic worth a unit test; the factory it
 * calls is tested in tests/ext-node-knowledge.test.ts.
 */

import { piEngineForSpec } from "../../agent/models.ts";
import { createExplanationWriter } from "../../agent/ext/explanation-writer.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import type { CostGate, ExplanationWriter } from "../../core/ext/node-knowledge-ports.ts";
import { callCost } from "../pricing.ts";
import { stores } from "../stores.ts";
import { costGate as sharedCostGate } from "./verification.ts";
import { createNodeKnowledge, NodeKnowledgeError } from "./node-knowledge.ts";
import { nodeHandlers, panelSources } from "./panel-providers.ts";
import { extStores } from "./stores.ts";

/** The strong slot (role "teacher"): explanation quality is the product. Read fresh per call. */
const writer: ExplanationWriter = {
	async write(request) {
		const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
		if (!spec) {
			throw new NodeKnowledgeError(503, "No model is configured for the strong slot (settings → models).");
		}
		return createExplanationWriter({ engine: piEngineForSpec(spec, true), priceCall: callCost }).write(request);
	},
};

/** Adapts the shared gate (record takes a source label) to the node-knowledge CostGate port. */
const costGate: CostGate = {
	allowed: () => sharedCostGate.allowed(),
	record: (usd) => sharedCostGate.record(usd, "node-knowledge"),
};

const knowledge = createNodeKnowledge({
	graphStore: stores.graphStore,
	explanations: extStores.explanationsStore,
	goalsStore: extStores.goalsStore,
	writer,
	cost: costGate,
	sources: panelSources,
	handlers: nodeHandlers,
});

export const nodePanel = knowledge.panel;
export const ensureNodeExplanation = knowledge.ensureExplanation;
/** Chapter-run entry for the lecture pipeline (REQ-node-04). */
export const generateNodeExplanations = knowledge.generateForNodes;
export const saveNodeExplanation = knowledge.saveExplanation;
export const decideNodeProposal = knowledge.decide;
export const runNodeAction = knowledge.runAction;
