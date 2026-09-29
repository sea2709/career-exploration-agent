import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { env } from './env.ts';

const { SANITY_API_TOKEN } = env;

const CONTEXT_API_VERSION = 'v2026-03-03';

let cachedInitialContext: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function defaultSanityContextMcpUrl(): string {
	return `https://api.sanity.io/${CONTEXT_API_VERSION}/context/mcp/${env.SANITY_PROJECT_ID}/${env.SANITY_DATASET}`;
}

export function resolveSanityContextMcpUrl(): string {
	return env.SANITY_CONTEXT_MCP_URL || defaultSanityContextMcpUrl();
}

function initialContextUrl(mcpUrl: string): string {
	const url = new URL(mcpUrl);
	url.pathname = `${url.pathname.replace(/\/$/, '')}/initial-context`;
	return url.toString();
}

/** Cached schema overview for the system prompt (skips the initial_context tool call). */
export async function fetchInitialContext(mcpUrl = resolveSanityContextMcpUrl()): Promise<string | null> {
	if (!SANITY_API_TOKEN) return null;

	const isStale = Date.now() - cacheTimestamp > CACHE_TTL_MS;
	const fetchPromise = isStale
		? fetch(initialContextUrl(mcpUrl), {
				headers: { Authorization: `Bearer ${SANITY_API_TOKEN}` },
			})
				.then(async (res) => {
					if (res.ok) {
						cachedInitialContext = await res.text();
						cacheTimestamp = Date.now();
					}
				})
				.catch(() => {})
		: null;

	if (!cachedInitialContext) await fetchPromise;

	return cachedInitialContext;
}

export function assertSanityContextConfigured(): void {
	if (!SANITY_API_TOKEN) {
		throw new Error(
			'SANITY_API_TOKEN is not set. Create a Viewer token (see agent/.env.example) for Sanity Context MCP access.',
		);
	}
}

export async function createSanityContextMcpClient(mcpUrl = resolveSanityContextMcpUrl()): Promise<MCPClient> {
	assertSanityContextConfigured();

	return createMCPClient({
		transport: {
			type: 'http',
			url: mcpUrl,
			headers: {
				Authorization: `Bearer ${SANITY_API_TOKEN}`,
			},
		},
	});
}

/** MCP tools, minus initial_context when its content is already injected into the system prompt. */
export async function loadSanityContextTools(mcpClient: MCPClient, hasInitialContext: boolean): Promise<ToolSet> {
	const allMcpTools = await mcpClient.tools();
	if (!hasInitialContext) return allMcpTools;
	const { initial_context: _ignored, ...mcpTools } = allMcpTools;
	return mcpTools;
}
