import { createClient } from '@sanity/client';
import { env } from './env.ts';

/** Read-only client; the O*NET dataset is public so no token is needed. */
export const sanity = createClient({
	projectId: env.SANITY_PROJECT_ID,
	dataset: env.SANITY_DATASET,
	apiVersion: '2023-08-24',
	useCdn: true,
});
