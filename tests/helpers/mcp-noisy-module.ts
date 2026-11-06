// tests/helpers/mcp-noisy-module.ts
// A dependency with side effects at import time: it prints on stdout while it loads.
console.log("planted: console.log at module level");
process.stdout.write("planted: raw stdout write at module level\n");
export const planted = true;
