import type { ServerResponse } from 'node:http';
import type { MCPClient } from '@ai-sdk/mcp';
import { pipeAgentUIStreamToResponse } from 'ai';
import { createCareerAgent } from './agent.ts';
import { createSanityContextMcpClient, fetchInitialContext, loadSanityContextTools } from './sanity-context.ts';
import { createInsightsIntegration } from './sanity-insights.ts';

export type ChatRequestBody = {
	messages: unknown[];
	/** useChat sends its chat id with every request; it doubles as the Insights thread id. */
	id?: string;
};

export async function handleChat({ messages, id: chatId }: ChatRequestBody, res: ServerResponse, abortSignal: AbortSignal) {
	let mcpClient: MCPClient | null = null;

	try {
		const [mcpClientResult, initialContext] = await Promise.all([
			createSanityContextMcpClient(),
			fetchInitialContext(),
		]);
		mcpClient = mcpClientResult;

		const sanityContextTools = await loadSanityContextTools(mcpClient, Boolean(initialContext));
		const agent = createCareerAgent({
			sanityContextTools,
			initialContext,
			insights: createInsightsIntegration(chatId),
		});

		await pipeAgentUIStreamToResponse({
			response: res,
			agent,
			uiMessages: messages,
			abortSignal,
			onEnd: async () => {
				await mcpClient?.close();
			},
			onError: (error) => {
				console.error('[chat]', error);
				return error instanceof Error ? error.message : 'Something went wrong.';
			},
		});
	} catch (error) {
		await mcpClient?.close();
		console.error('[chat]', error);
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		}
		res.end(error instanceof Error ? error.message : 'Something went wrong.');
	}
}
