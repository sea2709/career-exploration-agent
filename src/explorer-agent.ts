import { createGoogle } from '@ai-sdk/google';
import type { SanityInsightsIntegration } from '@sanity/context/ai-sdk';
import { isStepCount, tool, ToolLoopAgent, type InferAgentUIMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { env } from './env.ts';
import { compareOccupations, getOccupationProfile, getRelatedOccupations, searchOccupations } from './onet/data.ts';

export type CreateExplorerAgentOptions = {
	sanityContextTools?: ToolSet;
	initialContext?: string | null;
	insights?: SanityInsightsIntegration | null;
};

export const onetCode = z
	.string()
	.regex(/^\d{2}-\d{4}\.\d{2}$/)
	.describe('O*NET-SOC code, e.g. 15-2051.00');

export const explorerTools = {
	searchOccupations: tool({
		description:
			'Full-text search over O*NET occupations by title, alternate job titles, and description. ' +
			'Use this first whenever you do not already have an O*NET-SOC code. Every word must match, ' +
			'so prefer 1–2 distinctive keywords and run several searches for broad interests.',
		inputSchema: z.object({
			query: z.string().min(2).describe('Short keywords, e.g. "data analyst" or "animals"'),
			maxJobZone: z
				.number()
				.int()
				.min(1)
				.max(5)
				.optional()
				.describe('Only return occupations needing at most this much preparation (Job Zone 1–5)'),
			limit: z.number().int().min(1).max(15).default(8),
		}),
		execute: ({ query, maxJobZone, limit }) => searchOccupations(query, limit, maxJobZone),
	}),

	getOccupationProfile: tool({
		description:
			'Detailed profile of one occupation: description, Job Zone, typical education, core tasks, ' +
			'top skills/knowledge/abilities/work activities, work styles, and in-demand technologies.',
		inputSchema: z.object({ code: onetCode }),
		execute: ({ code }) => getOccupationProfile(code),
	}),

	compareOccupations: tool({
		description:
			'Compare a current occupation to a target occupation for a career move. Returns the biggest ' +
			'skill/knowledge/ability gaps, shared strengths, Job Zone change, and new technologies to learn.',
		inputSchema: z.object({
			fromCode: onetCode.describe('Current or starting occupation code'),
			toCode: onetCode.describe('Target occupation code'),
		}),
		execute: ({ fromCode, toCode }) => compareOccupations(fromCode, toCode),
	}),

	getRelatedOccupations: tool({
		description:
			'Occupations O*NET considers related to the given one, ordered by relatedness. ' +
			'Tiers: Primary-Short (closest), Primary-Long, Supplemental.',
		inputSchema: z.object({
			code: onetCode,
			limit: z.number().int().min(1).max(20).default(10),
		}),
		execute: ({ code, limit }) => getRelatedOccupations(code, limit),
	}),
};

function buildInstructions(initialContext?: string | null): string {
	return `You are a friendly, practical career exploration assistant backed by the O*NET 31.0 database in Sanity and fast local search tools.

${initialContext ? `# Content context\n\nUse this to understand Sanity document types and write accurate GROQ when needed.\n\n${initialContext}\n` : ''}
Grounding rules:
- Answer questions about specific occupations ONLY with data returned by your tools. Never invent tasks, ratings, education requirements, or O*NET-SOC codes.
- If you don't have a code, call searchOccupations first. If the search is ambiguous, pick the best match and mention alternatives.
- If the tools return nothing useful, say so plainly instead of guessing.
- O*NET has no salary or job-outlook data here; say that if asked rather than guessing numbers.

Tools:
- Prefer searchOccupations, getOccupationProfile, compareOccupations, and getRelatedOccupations for career questions — they are optimized for this app.
- Use groq_query when you need Sanity fields not covered by those tools, or to list, filter, or rank occupations across the dataset. Always include _id in projections.
- Use schema_explorer when you are unsure which fields exist on a document type.

Reading the data:
- Importance is 1–5 (how important the item is to the job). Level is 0–7 (how much of it is needed).
- Job Zones run 1 (little preparation) to 5 (extensive preparation, usually graduate degree).
- Work style impact runs -3 to 3; higher means the trait helps more in the job.

Answer style:
- Be concise and use Markdown: short paragraphs, bullet lists, bold for occupation names.
- The first time you mention an occupation, link it using the url from the tool result, e.g. [Data Scientists (15-2051.00)](url).
- When someone describes interests rather than a job title, translate them into a few searches and suggest 3–5 occupations with a one-line reason each.
- For career changes, use compareOccupations and turn the gaps into concrete next steps.
- End with one short follow-up question that helps the user explore further.`;
}

export function createExplorerAgent(options: CreateExplorerAgentOptions = {}) {
	if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
		throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set. Add it to agent/.env (see .env.example).');
	}
	const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
	const { sanityContextTools = {}, initialContext, insights } = options;

	return new ToolLoopAgent({
		model: google(env.GEMINI_MODEL),
		instructions: buildInstructions(initialContext),
		tools: {
			...explorerTools,
			...sanityContextTools,
		},
		stopWhen: isStepCount(12),
		telemetry: insights ? { integrations: [insights] } : undefined,
	});
}

export type ExplorerAgentUIMessage = InferAgentUIMessage<ReturnType<typeof createExplorerAgent>>;
