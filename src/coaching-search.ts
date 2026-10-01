import type { ServerResponse } from 'node:http';
import type { MCPClient } from '@ai-sdk/mcp';
import { env } from './env.ts';
import { createSanityContextMcpClient, fetchInitialContext } from './sanity-context.ts';

const MAX_QUERY_LENGTH = 200;
const RESULT_LIMIT = 8;

export type CoachingSearchRequestBody = { query: string };

/** Mirrored by `CoachingSearchResult` in web/src/components/CoachingGuidesPanel.tsx. */
export type CoachingSearchResult = {
	path: string;
	title: string;
	summary: string;
	score: number;
	/** The entry's Markdown, without its leading title and summary. */
	content: string;
};

export function isCoachingSearchRequestBody(body: unknown): body is CoachingSearchRequestBody {
	return typeof body === 'object' && body !== null && typeof (body as CoachingSearchRequestBody).query === 'string';
}

/**
 * Keyword search over the coaching Knowledge Base (SANITY_COACHING_MCP_URL), for the coaching
 * guides panel. Runs knowledge_base_search, then reads the hits in one knowledge_base_read call.
 */
export async function handleCoachingSearch({ query }: CoachingSearchRequestBody, res: ServerResponse) {
	const q = query.trim().slice(0, MAX_QUERY_LENGTH);
	if (!q) return sendJson(res, 400, { error: 'Expected a non-empty query.' });

	const { SANITY_COACHING_MCP_URL: mcpUrl, SANITY_COACHING_TOKEN: token } = env;
	if (!mcpUrl || !token) {
		return sendJson(res, 503, { error: 'Coaching search is not configured.' });
	}

	let client: MCPClient | null = null;
	try {
		const [mcpClient, initialContext] = await Promise.all([
			createSanityContextMcpClient(mcpUrl, token),
			fetchInitialContext(mcpUrl, token),
		]);
		client = mcpClient;
		const knowledgeBase = knowledgeBaseId(initialContext);
		if (!knowledgeBase) throw new Error('Could not find the knowledge base id in initial_context.');

		const hits = parseSearchHits(
			await callText(client, 'knowledge_base_search', { knowledgeBase, query: q, return: 'paths', limit: RESULT_LIMIT }),
		);
		if (!hits.length) return sendJson(res, 200, { results: [] });

		const entries = splitEntries(await callText(client, 'knowledge_base_read', { knowledgeBase, paths: hits.map((h) => h.path) }));
		const results: CoachingSearchResult[] = hits.map((hit, i) => ({
			...hit,
			content: entryBody(entries.find((e) => e.startsWith(`# ${hit.title}\n`)) ?? entries[i] ?? '', hit),
		}));
		sendJson(res, 200, { results });
	} catch (error) {
		console.error('[coaching-search]', error);
		sendJson(res, 502, { error: 'The coaching Knowledge Base is unavailable.' });
	} finally {
		await client?.close();
	}
}

async function callText(client: MCPClient, name: string, args: Record<string, unknown>): Promise<string> {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content as { type: string; text?: string }[])
		.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
		.join('\n');
	if (result.isError) throw new Error(`${name} failed: ${text}`);
	return text;
}

function knowledgeBaseId(initialContext: string | null): string | undefined {
	return initialContext ? /Knowledge base id:\s*`(kb\w+)`/.exec(initialContext)?.[1] : undefined;
}

/** Parses lines like "1. `grading` (score 6.11): Title" followed by an indented summary line. */
function parseSearchHits(text: string): Omit<CoachingSearchResult, 'content'>[] {
	const pattern = /^\d+\. `([^`]+)` \(score ([\d.]+)\): (.+)\n {2,}(.+)$/gm;
	return [...text.matchAll(pattern)].map(([, path, score, title, summary]) => ({
		path,
		title: title.trim(),
		summary: summary.trim(),
		score: Number(score),
	}));
}

function splitEntries(text: string): string[] {
	return text.split(/\n+---\n+/).map((entry) => entry.trim());
}

function entryBody(entry: string, { title, summary }: { title: string; summary: string }): string {
	let body = entry.replace(`# ${title}`, '').trimStart();
	if (body.startsWith(summary)) body = body.slice(summary.length).trimStart();
	return body;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}
