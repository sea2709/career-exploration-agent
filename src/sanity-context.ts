import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { env } from './env.ts';

const { SANITY_API_TOKEN } = env;

const CONTEXT_API_VERSION = 'v2026-03-03';

const CACHE_TTL_MS = 5 * 60 * 1000;
const initialContextCache = new Map<string, { text: string; fetchedAt: number }>();

export type SanityContextConnection = {
	client: MCPClient;
	tools: ToolSet;
	initialContext: string | null;
};

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

/** Cached initial context for the system prompt (skips the initial_context tool call), per endpoint. */
export async function fetchInitialContext(
	mcpUrl = resolveSanityContextMcpUrl(),
	token = SANITY_API_TOKEN,
): Promise<string | null> {
	if (!token) return null;

	const cached = initialContextCache.get(mcpUrl);
	const isStale = !cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS;
	const fetchPromise = isStale
		? fetch(initialContextUrl(mcpUrl), {
				headers: { Authorization: `Bearer ${token}` },
			})
				.then(async (res) => {
					if (res.ok) {
						initialContextCache.set(mcpUrl, { text: await res.text(), fetchedAt: Date.now() });
					}
				})
				.catch(() => {})
		: null;

	if (!cached) await fetchPromise;

	return initialContextCache.get(mcpUrl)?.text ?? null;
}

export function assertSanityContextConfigured(): void {
	if (!SANITY_API_TOKEN) {
		throw new Error(
			'SANITY_API_TOKEN is not set. Create a Viewer token (see agent/.env.example) for Sanity Context MCP access.',
		);
	}
}

export async function createSanityContextMcpClient(
	mcpUrl = resolveSanityContextMcpUrl(),
	token = SANITY_API_TOKEN,
): Promise<MCPClient> {
	if (!token) assertSanityContextConfigured();

	return createMCPClient({
		transport: {
			type: 'http',
			url: mcpUrl,
			headers: {
				Authorization: `Bearer ${token}`,
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

/** Opens an MCP client and loads its tools and initial context. The caller must close `client`. */
export async function connectSanityContext(
	mcpUrl = resolveSanityContextMcpUrl(),
	token = SANITY_API_TOKEN,
): Promise<SanityContextConnection> {
	const [client, initialContext] = await Promise.all([
		createSanityContextMcpClient(mcpUrl, token),
		fetchInitialContext(mcpUrl, token),
	]);
	try {
		return { client, initialContext, tools: await loadSanityContextTools(client, Boolean(initialContext)) };
	} catch (error) {
		await client.close();
		throw error;
	}
}
