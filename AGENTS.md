# agent/ — Career Explorer agent service

Node HTTP service that runs a Gemini `ToolLoopAgent` over the O\*NET dataset in Sanity and streams AI SDK UI messages to `web/`. See `README.md` for setup, the HTTP API, and architecture.

## Development

- `npm run dev` starts the server with `node --watch` on port 8787. It exits immediately if `AGENT_API_TOKEN` isn't set.
- `npm run typecheck` runs `tsc`. There is no test suite, linter, or build step.
- Smoke-test with `GET /health`, or `POST /chat` using the curl example in `README.md`.
- To test through the real UI, also run `web/` (`astro dev --background`) with the same `AGENT_API_TOKEN` in `web/.env`.

## Layout

- `src/server.ts`: HTTP server, bearer auth, CORS, routing.
- `src/chat.ts`: per-request wiring. It creates the MCP client, fetches initial context, builds the agent, and pipes the stream.
- `src/agent.ts`: local tool definitions (zod schemas), the system prompt in `buildInstructions`, and `createCareerAgent`.
- `src/onet/data.ts`: GROQ queries and result shaping behind the local tools.
- `src/sanity-context.ts`: Sanity Context MCP client and the cached initial-context fetch.
- `src/sanity-insights.ts`: optional Conversation Insights integration.
- `src/env.ts`: the only place that reads `process.env`.
- `skills/`: Sanity Context skills installed from `sanity-io/context` and pinned in `skills-lock.json`. Treat them as vendored; don't edit them by hand.

## Conventions and constraints

- **TypeScript runs directly in Node** via type stripping (`erasableSyntaxOnly`). Don't use enums, namespaces, parameter properties, or other syntax that needs transpiling. Relative imports must include the `.ts` extension, and type-only imports must use `import type` (`verbatimModuleSyntax`).
- **Env vars go through `src/env.ts`.** Add new vars there with a default where sensible, and document them in `.env.example` and the `README.md` table.
- **Keep the HTTP layer dependency-free.** It's plain `node:http`. Don't add Express or similar without a good reason.
- **Protect `/chat`.** Every route that does agent or LLM work must go through `isAuthorized`. `web/` is the only intended caller and sends the token server-side.
- **Tools must stay grounded.** Local tools return data from Sanity only. When a lookup misses, return an `{ error }` object (see `notFound` in `onet/data.ts`) so the model can recover instead of throwing. Include a `url` from `onetUrl` on occupation results, because the system prompt tells the model to link with it.
- **Keep tool results compact.** They go into the model's context, so slice lists and truncate long text as the existing tools do.
- **Adding or renaming a tool affects two other places:**
  1. The "Tools" section of `buildInstructions` in `agent.ts`, so the model knows when to use it.
  2. `TOOL_LABELS` in `web/src/components/CareerChat.tsx`, so the UI chip shows a readable label.
- **The O\*NET dataset is public.** `src/sanity.ts` reads it through the CDN without a token. `SANITY_API_TOKEN` is only for the Context MCP endpoint, and `SANITY_INSIGHTS_TOKEN` is only for writing Insights transcripts.
- **Schema reference:** O\*NET document types are defined in `../studio/schemaTypes`, and generated types live in `../web/sanity.types.ts`. Check them before writing new GROQ.
- **Insights endpoint name:** `SANITY_CONTEXT_ENDPOINT_NAME` must match the value used by the root `functions/classify-conversations` Sanity Function.
- Code style: tabs, single quotes, semicolons.

## Agent skills

Consult these in `skills/` before changing how the agent uses Sanity Context:

- `create-agent-with-sanity-context`: MCP setup, system prompts, and Insights. See `references/system-prompts.md` and `references/conversation-classification.md`.
- `shape-your-agent`: refining the system prompt and agent behavior.
- `dial-your-context`: writing the Context MCP endpoint's Instructions field (data-specific guidance, content filters) when the agent misreads the schema or writes bad GROQ.

## Documentation

- AI SDK agents (`ToolLoopAgent`, tools, stop conditions): https://ai-sdk.dev/docs/agents
- AI SDK MCP client: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- Google Gemini provider: https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
- Sanity Context: https://www.sanity.io/docs/context
- GROQ: https://www.sanity.io/docs/groq
