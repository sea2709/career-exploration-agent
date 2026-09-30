const optional = (name: string) => process.env[name]?.trim() || undefined;

export const env = {
	PORT: Number(optional('PORT') ?? 8787),
	/** Shared secret callers must send as `Authorization: Bearer <token>` on POST /chat. */
	AGENT_API_TOKEN: optional('AGENT_API_TOKEN'),
	/** Comma-separated origins allowed to call the agent from a browser. */
	ALLOWED_ORIGINS: (optional('ALLOWED_ORIGINS') ?? 'http://localhost:4321').split(',').map((o) => o.trim()),

	GOOGLE_GENERATIVE_AI_API_KEY: optional('GOOGLE_GENERATIVE_AI_API_KEY'),
	GEMINI_MODEL: optional('GEMINI_MODEL') ?? 'gemini-3.8-flash',

	SANITY_PROJECT_ID: optional('SANITY_PROJECT_ID') ?? 'rhq335ze',
	SANITY_DATASET: optional('SANITY_DATASET') ?? 'production',
	SANITY_API_TOKEN: optional('SANITY_API_TOKEN'),
	SANITY_CONTEXT_MCP_URL: optional('SANITY_CONTEXT_MCP_URL'),
	/** Context MCP endpoint whose content source is the interview coaching Knowledge Base. Optional. */
	SANITY_COACHING_MCP_URL: optional('SANITY_COACHING_MCP_URL'),
	/** Organization token with Context access for SANITY_COACHING_MCP_URL. Falls back to SANITY_API_TOKEN. */
	SANITY_COACHING_TOKEN: optional('SANITY_COACHING_TOKEN') ?? optional('SANITY_API_TOKEN'),

	SANITY_ORGANIZATION_ID: optional('SANITY_ORGANIZATION_ID'),
	SANITY_CONTEXT_ENDPOINT_NAME: optional('SANITY_CONTEXT_ENDPOINT_NAME') ?? 'career-explorer',
	SANITY_INSIGHTS_TOKEN: optional('SANITY_INSIGHTS_TOKEN'),
};
