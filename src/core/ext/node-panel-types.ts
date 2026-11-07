// src/core/ext/node-panel-types.ts
/**
 * Data of the node panel (node-knowledge spec: REQ-node-12, REQ-node-13,
 * REQ-node-14). Types plus one const; nothing here imports server code, so
 * the browser shell can use it through the core barrel. `PanelSources` is
 * the seam through which other children's data arrives (trust, lectures,
 * cards, review): every member is optional and an absent one yields an
 * empty section.
 */

export type NodeAction =
	| "createCard"
	| "pin"
	| "retire"
	| "startReview"
	| "askInChat"
	| "useAsGoalTarget"
	| "verifyNow";

export const NODE_ACTIONS: readonly NodeAction[] = [
	"createCard",
	"pin",
	"retire",
	"startReview",
	"askInChat",
	"useAsGoalTarget",
	"verifyNow",
];

export interface NodeRef {
	id: string;
	name: string;
}

export type PanelTrustLevel = "unverified" | "sourced" | "contested" | "refuted";

export interface PanelEvidence {
	sourceId: string;
	locator: string;
	quote: string;
	stance: "supports" | "contradicts";
	tier: "primary" | "secondary" | "unvetted";
	snapshotHash: string;
}

export interface PanelTrust {
	level: PanelTrustLevel;
	evidence: PanelEvidence[];
}

export interface PanelLecture {
	lectureId: string;
	title: string;
}

/** A page of a registered document the node came from (assisted study, REQ-study-10). */
export interface PanelStudySource {
	documentId: string;
	title: string;
	page: number;
}

/** One session note of a chat the node came from (session-notes spec, REQ-sn-06). */
export interface PanelStudyNote {
	chatId: string;
	chatTitle: string;
	text: string;
	edited: boolean;
	updatedAt: string;
}

export interface PanelCard {
	cardId: string;
	question: string;
	status: string;
}

export interface PanelReview {
	dueAt: string | null;
	reps: number;
	pinned: boolean;
	retired: boolean;
}

export interface PanelGoal {
	id: string;
	title: string;
	status: "active" | "paused" | "reached";
	isTarget: boolean;
}

/** Data other child specs supply; each member optional (absent = empty section). */
export interface PanelSources {
	trust?(nodeId: string): PanelTrust;
	lecturesCiting?(nodeId: string): PanelLecture[];
	studySources?(nodeId: string): PanelStudySource[];
	studyNotes?(nodeId: string): PanelStudyNote[];
	cards?(nodeId: string): PanelCard[];
	review?(nodeId: string): PanelReview | null;
}

export type ExplanationState = "current" | "stale" | "missing";

export interface ExplanationView {
	state: ExplanationState;
	/** True when a missing or stale text cannot be generated now: the daily ceiling is reached. */
	ceiling: boolean;
	form: "short" | "long";
	current: { version: number; body: string; author: "agent" | "user"; noSource: boolean } | null;
	proposal: { version: number; body: string } | null;
	/** Names of the nodes linked from `current` and `proposal`, by id. */
	linkNames: Record<string, string>;
}

export interface NodePanelData {
	node: { id: string; name: string; statement: string; aliases: string[] };
	explanation: ExplanationView;
	trust: PanelTrust;
	/** One entry per chain concluding the node; more than one means alternative arguments. */
	concluding: Array<{ chainId: string; premises: NodeRef[] }>;
	usedAsPremise: Array<{ chainId: string; coPremises: NodeRef[]; conclusion: NodeRef }>;
	citingLectures: PanelLecture[];
	/** Where in the learner's documents the node came from (study-links), with the document's title. */
	studySources: PanelStudySource[];
	/** The study notes of the chats the node came from ("How you wanted to study this"). */
	studyNotes: PanelStudyNote[];
	/** Nodes whose current explanation links here (derived, never stored). */
	mentionedBy: NodeRef[];
	cards: PanelCard[];
	review: PanelReview | null;
	goals: PanelGoal[];
	/** Depth 0 to 2 around the node; the view filters to the chosen depth. */
	neighbourhood: { nodes: Array<NodeRef & { depth: number }>; edges: Array<{ from: string; to: string }> };
	availableActions: NodeAction[];
}
