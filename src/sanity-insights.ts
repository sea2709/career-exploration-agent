import { createClient, type SanityClient } from '@sanity/client';
import { sanityInsightsIntegration, type SanityInsightsIntegration } from '@sanity/context/ai-sdk';
import { env } from './env.ts';

let insightsClient: SanityClient | null = null;

function getInsightsClient(): SanityClient | null {
	if (!env.SANITY_INSIGHTS_TOKEN || !env.SANITY_ORGANIZATION_ID) return null;

	insightsClient ??= createClient({
		apiVersion: 'v2025-11-27',
		token: env.SANITY_INSIGHTS_TOKEN,
		context: { organizationId: env.SANITY_ORGANIZATION_ID },
		useCdn: false,
		useProjectHostname: false,
	});
	return insightsClient;
}

/** Saves the transcript to the org's Context store. Returns null when Insights isn't configured. */
export function createInsightsIntegration(threadId: string | undefined): SanityInsightsIntegration | null {
	const client = getInsightsClient();
	if (!client || !threadId) return null;

	return sanityInsightsIntegration({
		client,
		threadId,
		metadata: { mcpEndpoints: env.SANITY_CONTEXT_ENDPOINT_NAME },
	});
}
