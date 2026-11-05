// src/core/ext/index.ts
/**
 * Browser-safe barrel of the extension core. Only modules without node:
 * imports belong here (graph-reading modules such as node-panel.ts and
 * goal-service.ts stay out, like core/graph.ts stays out of core/index.ts).
 */
export * from "./explanation-check.ts";
export * from "./neighbourhood.ts";
export * from "./node-panel-types.ts";
export * from "./panel-history.ts";
