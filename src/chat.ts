import type { ServerResponse } from 'node:http';
import { pipeAgentUIStreamToResponse } from 'ai';
import { env } from './env.ts';
import { createExplorerAgent } from './explorer-agent.ts';
import { createInterviewAgent } from './interview-agent.ts';
import { createQuizAgent } from './quiz-agent.ts';
import { connectSanityContext, type SanityContextConnection } from './sanity-context.ts';
import { createInsightsIntegration } from './sanity-insights.ts';

export type ChatRequestBody = {
	messages: unknown[];
	/** useChat sends its chat id with every request; it doubles as the Insights thread id. */
	id?: string;
};

export async function handleChat({ messages, id: chatId }: ChatRequestBody, res: ServerResponse, abortSignal: AbortSignal) {
	let context: SanityContextConnection | null = null;

	try {
		context = await connectSanityContext();

		const agent = createExplorerAgent({
			sanityContextTools: context.tools,
			initialContext: context.initialContext,
			insights: createInsightsIntegration(chatId),
		});

		await pipeAgentUIStreamToResponse({
			response: res,
			agent,
			uiMessages: messages,
			abortSignal,
			onEnd: async () => {
				await context?.client.close();
			},
			onError: (error) => {
				console.error('[chat]', error);
				return error instanceof Error ? error.message : 'Something went wrong.';
			},
		});
	} catch (error) {
		await context?.client.close();
		failRequest(res, '[chat]', error);
	}
}

/**
 * Mock interview coach. Uses the local O*NET tools, plus the coaching Knowledge Base when
 * SANITY_COACHING_MCP_URL is set. No Insights wiring.
 */
export async function handleInterview({ messages }: ChatRequestBody, res: ServerResponse, abortSignal: AbortSignal) {
	const coaching = await connectCoachingKnowledge();

	try {
		await pipeAgentUIStreamToResponse({
			response: res,
			agent: createInterviewAgent({
				coachingTools: coaching?.tools,
				coachingOutline: coaching?.initialContext,
			}),
			uiMessages: messages,
			abortSignal,
			onEnd: async () => {
				await coaching?.client.close();
			},
			onError: (error) => {
				console.error('[interview]', error);
				return error instanceof Error ? error.message : 'Something went wrong.';
			},
		});
	} catch (error) {
		await coaching?.client.close();
		failRequest(res, '[interview]', error);
	}
}

/** Interest quiz. Local O*NET tools only; activity ratings arrive as presentActivities tool outputs. */
export async function handleQuiz({ messages }: ChatRequestBody, res: ServerResponse, abortSignal: AbortSignal) {
	try {
		await pipeAgentUIStreamToResponse({
			response: res,
			agent: createQuizAgent(messages),
			uiMessages: messages,
			abortSignal,
			onError: (error) => {
				console.error('[quiz]', error);
				return error instanceof Error ? error.message : 'Something went wrong.';
			},
		});
	} catch (error) {
		failRequest(res, '[quiz]', error);
	}
}

/** The interview works without coaching guidance, so connection failures are logged, not thrown. */
async function connectCoachingKnowledge(): Promise<SanityContextConnection | null> {
	if (!env.SANITY_COACHING_MCP_URL || !env.SANITY_COACHING_TOKEN) return null;
	try {
		return await connectSanityContext(env.SANITY_COACHING_MCP_URL, env.SANITY_COACHING_TOKEN);
	} catch (error) {
		console.warn('[interview] Coaching knowledge base unavailable, continuing without it:', error);
		return null;
	}
}

function failRequest(res: ServerResponse, label: string, error: unknown) {
	console.error(label, error);
	if (!res.headersSent) {
		res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
	}
	res.end(error instanceof Error ? error.message : 'Something went wrong.');
}
