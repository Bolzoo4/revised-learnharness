// tests/helpers/mcp-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server/ext/mcp/server.ts";
import type { Fixture } from "./mcp-fixture.ts";

export type Json = any;

export async function connect(f: Fixture, knowledgeOnly = false): Promise<{ client: Client; logs: string[]; close(): Promise<void> }> {
	const logs: string[] = [];
	const server = createServer(f.deps, { knowledgeOnly, log: (m) => logs.push(m) });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return { client, logs, close: async () => { await client.close(); await server.close(); } };
}

export async function callTool(client: Client, name: string, args: unknown = {}): Promise<{ isError: boolean; body: Json; text: string }> {
	const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	const text = r.content.map((c) => c.text ?? "").join("");
	return { isError: r.isError === true, body: r.structuredContent ?? parse(text), text };
}

function parse(text: string): Json {
	try {
		return JSON.parse(text);
	} catch {
		return { error: { code: "protocol", message: text } };
	}
}
