import { createGoogle } from '@ai-sdk/google';
import { isStepCount, tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';
import { env } from './env.ts';
import { explorerTools } from './explorer-agent.ts';
import {
	buildInterestProfile,
	getQuizActivities,
	matchOccupations,
	RATINGS,
	type ActivityRating,
} from './onet/interests.ts';

const quizRound = z.enum(['broad', 'focused']);

const activityRatings = z.object({
	ratings: z.array(z.object({ id: z.string(), rating: z.enum(RATINGS) })),
});

export type QuizRatings = z.infer<typeof activityRatings>;

/**
 * Collect the user's answers from presentActivities tool parts in the UI messages. Later rounds
 * override earlier ratings of the same activity.
 */
export function ratingsFromMessages(messages: unknown[]): ActivityRating[] {
	const byId = new Map<string, ActivityRating>();
	for (const message of messages) {
		const parts = (message as { parts?: unknown[] })?.parts;
		if (!Array.isArray(parts)) continue;
		for (const part of parts) {
			const p = part as { type?: string; state?: string; output?: unknown };
			if (p.type !== 'tool-presentActivities' || p.state !== 'output-available') continue;
			const parsed = activityRatings.safeParse(p.output);
			if (parsed.success) for (const r of parsed.data.ratings) byId.set(r.id, r);
		}
	}
	return [...byId.values()];
}

function createQuizTools(ratings: ActivityRating[]) {
	return {
		getQuizActivities: tool({
			description:
				'Get the activities for one quiz round. "broad" covers all six RIASEC types. "focused" samples Specific ' +
				'Interest Areas under the user’s two leading types, based on the broad-round ratings.',
			inputSchema: z.object({ round: quizRound }),
			execute: ({ round }) => getQuizActivities(round, ratings),
		}),

		presentActivities: tool({
			description:
				'Show the activities from the latest getQuizActivities call for this round as a rating card, and wait ' +
				'for the user to rate each one on a 5-point scale from strongly dislike to strongly like. Call right after ' +
				'getQuizActivities.',
			inputSchema: z.object({
				round: quizRound,
				intro: z.string().describe('One short sentence shown above the card'),
			}),
			outputSchema: activityRatings,
		}),

		buildInterestProfile: tool({
			description:
				'Score all ratings so far into a RIASEC interest profile: Holland code, type scores (1–7), and liked ' +
				'or disliked Specific Interest Areas. The UI shows this as a profile card.',
			inputSchema: z.object({}),
			execute: () => buildInterestProfile(ratings),
		}),

		matchOccupations: tool({
			description:
				'Occupations whose O*NET interest profile best fits the user’s ratings, with a match percent and the ' +
				'liked interest areas they share. The UI shows this as a match list.',
			inputSchema: z.object({
				maxJobZone: z
					.number()
					.int()
					.min(1)
					.max(5)
					.optional()
					.describe('Only occupations needing at most this much preparation (Job Zone 1–5)'),
				limit: z.number().int().min(3).max(15).default(10),
			}),
			execute: ({ maxJobZone, limit }) => matchOccupations(ratings, limit, maxJobZone),
		}),

		searchOccupations: explorerTools.searchOccupations,
		getOccupationProfile: explorerTools.getOccupationProfile,
		getRelatedOccupations: explorerTools.getRelatedOccupations,
	};
}

const instructions = `You run a short career interest quiz based on the O*NET Interest Profiler and its six RIASEC types (Realistic, Investigative, Artistic, Social, Enterprising, Conventional). Users rate everyday work activities; the tools score them and match occupations using O*NET 31.0 interest data.

# Flow
1. The first message gives the most preparation the user is open to, as a Job Zone (or "any"). Reply with one or two sentences: what the quiz does, and to rate each activity by whether they'd enjoy it, not whether they have experience or how much it pays. Then call getQuizActivities with round "broad", then presentActivities with round "broad". Stop and wait.
2. When the broad ratings come back, call getQuizActivities with round "focused", then presentActivities with round "focused". The intro names the leading types from focusTypes, e.g. "You lean Investigative and Conventional, so let's narrow down within those."
3. When the focused ratings come back, call buildInterestProfile, then matchOccupations with the Job Zone from the first message (omit maxJobZone for "any").
4. Then write a short summary (under 150 words):
   - What their three-letter Holland code means in plain words, using the type descriptions.
   - Two or three standout matches, each linked with its url and one reason tied to their liked areas or types.
   - One next step: ask about any match, widen the Job Zone, or practice with the Mock Interview tab.
   The cards already show every score and match, so don't list them all again.

# Follow-ups
- Answer questions about a match with getOccupationProfile or getRelatedOccupations. Re-run matchOccupations to change the Job Zone or show more matches.
- If the user wants to retake a round, call getQuizActivities and presentActivities again for that round.

# Rules
- Never invent scores, matches, or O*NET data. Use only what the tools return.
- Interests are about enjoyment, not ability. Say so if the user worries they lack skills for a match.
- Keep replies short. Markdown sparingly: short paragraphs, bold occupation names.`;

export function createQuizAgent(messages: unknown[]) {
	if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
		throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not set. Add it to agent/.env (see .env.example).');
	}
	const google = createGoogle({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });

	return new ToolLoopAgent({
		model: google(env.GEMINI_MODEL),
		instructions,
		tools: createQuizTools(ratingsFromMessages(messages)),
		stopWhen: isStepCount(8),
	});
}
