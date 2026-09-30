# Career agent

A small Node HTTP service that runs the Career Explorer chat agent. It takes AI SDK UI messages, runs a Gemini-backed `ToolLoopAgent` grounded in the O\*NET 31.0 dataset stored in Sanity, and streams the reply back as an AI SDK UI message stream.

The `web/` app is its only intended caller. The browser talks to `web/`'s `/api/chat` route, which checks the visitor passed a Turnstile human check and then calls this service with a shared bearer token.

```
web /api/chat ──POST /chat (Bearer AGENT_API_TOKEN)──▶ agent
                                                        ├─ local O*NET tools ──GROQ──▶ Sanity dataset (public, CDN)
                                                        ├─ Sanity Context MCP (groq_query, schema_explorer)
                                                        ├─ Gemini (GOOGLE_GENERATIVE_AI_API_KEY)
                                                        └─ Conversation Insights (optional) ──▶ org Context store
```

## Stack

- Node `>=22.18.0`, running TypeScript directly via Node's built-in type stripping (no build step)
- Plain `node:http` server, no framework
- [AI SDK](https://ai-sdk.dev) (`ai`, `@ai-sdk/google`, `@ai-sdk/mcp`) with `ToolLoopAgent`
- `@sanity/client` for GROQ queries against the O\*NET dataset
- `@sanity/context` for [Sanity Context](https://www.sanity.io/docs/context) MCP tools and Conversation Insights
- `zod` for tool input schemas

## Getting started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create `.env` from the example and fill it in:

   ```sh
   cp .env.example .env
   ```

   At minimum you need `GOOGLE_GENERATIVE_AI_API_KEY`, `SANITY_API_TOKEN`, and `AGENT_API_TOKEN`. Generate the last one with `openssl rand -base64 32` and put the same value in `web/.env`.

3. Start the server with file watching:

   ```sh
   npm run dev
   ```

   It listens on `http://localhost:8787` by default.

## Commands

| Command             | Action                                             |
| ------------------- | -------------------------------------------------- |
| `npm run dev`       | Start with `node --watch`, loading `.env` if present |
| `npm start`         | Start without watching                             |
| `npm run typecheck` | Type-check with `tsc` (no emit)                    |

## HTTP API

| Method    | Path      | Auth           | Description                                                  |
| --------- | --------- | -------------- | ------------------------------------------------------------ |
| `POST`    | `/chat`   | Bearer token   | Run the agent and stream an AI SDK UI message stream back    |
| `GET`     | `/health` | none           | Returns `{"ok":true}`                                        |
| `OPTIONS` | any       | none           | CORS preflight                                               |

`POST /chat` expects the body that AI SDK's `useChat` sends: `{ id, messages }`, where `messages` is an array of UI messages. `id` is optional, but when present it's used as the Conversation Insights thread id.

Responses:

- `401` when the `Authorization: Bearer <AGENT_API_TOKEN>` header is missing or wrong. The token comparison is constant-time.
- `400` for invalid JSON or a body without a `messages` array.
- `500` with a plain-text message if setup fails before streaming starts, for example a missing API key.
- Anything else returns `404`.

If the client disconnects mid-stream, the agent run is aborted.

CORS headers are only added for origins listed in `ALLOWED_ORIGINS`. Server-to-server calls from `web/` don't send an `Origin` header, so this only matters if a browser calls the agent directly.

Example:

```sh
curl -N http://localhost:8787/chat \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"test","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"What does a data scientist do?"}]}]}'
```

## Environment variables

All variables are read in `src/env.ts`. Blank values are treated as unset.

| Variable                       | Required | Default                              | Purpose                                                              |
| ------------------------------ | -------- | ------------------------------------ | -------------------------------------------------------------------- |
| `AGENT_API_TOKEN`              | yes      | none                                 | Bearer token callers must send. The server exits at startup without it. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes      | none                                 | Gemini API key                                                       |
| `SANITY_API_TOKEN`             | yes      | none                                 | Viewer token for the Sanity Context MCP endpoint                     |
| `GEMINI_MODEL`                 | no       | `gemini-3.5-flash`                   | Gemini model id                                                      |
| `PORT`                         | no       | `8787`                               | HTTP port                                                            |
| `ALLOWED_ORIGINS`              | no       | `http://localhost:4321`              | Comma-separated browser origins that get CORS headers                |
| `SANITY_PROJECT_ID`            | no       | `rhq335ze`                           | Sanity project                                                       |
| `SANITY_DATASET`               | no       | `production`                         | Sanity dataset                                                       |
| `SANITY_CONTEXT_MCP_URL`       | no       | dataset-addressed legacy endpoint    | Override for an org-level Context MCP endpoint                       |
| `SANITY_ORGANIZATION_ID`       | no       | none                                 | Enables Conversation Insights (with `SANITY_INSIGHTS_TOKEN`)         |
| `SANITY_INSIGHTS_TOKEN`        | no       | none                                 | Editor token for writing Insights transcripts                        |
| `SANITY_CONTEXT_ENDPOINT_NAME` | no       | `career-explorer`                    | Groups conversations in the Insights dashboard                       |

Only `AGENT_API_TOKEN` is checked at startup. A missing `GOOGLE_GENERATIVE_AI_API_KEY` or `SANITY_API_TOKEN` surfaces as a `500` on the first `/chat` request.

If you set `SANITY_CONTEXT_MCP_URL` to an organization endpoint, `SANITY_API_TOKEN` must be an organization token with Context access. See `.env.example` for the commands that create each token.

## How a chat request is handled

1. `server.ts` authenticates the request, parses the body, and calls `handleChat`.
2. `chat.ts` opens a Sanity Context MCP client and fetches the dataset's initial context (a schema overview) in parallel.
3. The initial context is cached in memory for 5 minutes. When stale, it's refreshed in the background while the cached copy is used.
4. MCP tools are loaded. When the initial context was fetched, the `initial_context` tool is dropped because its content is already in the system prompt.
5. `agent.ts` builds a `ToolLoopAgent` with the local O\*NET tools, the MCP tools, the system prompt, and the optional Insights integration. It stops after 12 steps.
6. `pipeAgentUIStreamToResponse` streams the result to the response and closes the MCP client when done.

## Tools

The local tools in `src/onet/data.ts` run GROQ directly against the public O\*NET dataset (CDN, no token). The system prompt tells the model to prefer them.

| Tool                     | Input                              | Returns                                                                   |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `searchOccupations`      | `query`, `maxJobZone?`, `limit`    | Matching occupations scored by title, alternate titles, and description   |
| `getOccupationProfile`   | `code`                             | Description, Job Zone, education, core tasks, top skills/knowledge/abilities/activities, work styles, hot technologies |
| `compareOccupations`     | `fromCode`, `toCode`               | Skill/knowledge/ability gaps, shared strengths, Job Zone change, new technologies |
| `getRelatedOccupations`  | `code`, `limit`                    | Related occupations ordered by O\*NET relatedness tier                    |

Codes are O\*NET-SOC codes like `15-2051.00`. Every result includes an `onetonline.org` URL the model uses for links.

The Sanity Context MCP server adds `groq_query` and `schema_explorer` for questions the local tools don't cover.

## Conversation Insights

When `SANITY_ORGANIZATION_ID` and `SANITY_INSIGHTS_TOKEN` are set and the request includes a chat `id`, each transcript is saved to the organization's Context store under `SANITY_CONTEXT_ENDPOINT_NAME`. The scheduled `classify-conversations` Sanity Function at the repo root (`functions/`, deployed via `sanity.blueprint.ts`) classifies those transcripts hourly, so it must use the same endpoint name.

## Project structure

```
src/
├── server.ts           # HTTP server, bearer auth, CORS, routing
├── chat.ts             # Per-request wiring: MCP client, initial context, agent, streaming
├── agent.ts            # Local tool definitions, system prompt, ToolLoopAgent factory
├── env.ts              # Environment variables and defaults
├── sanity.ts           # Read-only Sanity client for the O*NET dataset
├── sanity-context.ts   # Context MCP client, initial-context fetch and cache
├── sanity-insights.ts  # Conversation Insights integration
└── onet/
    └── data.ts         # GROQ queries and shaping for the O*NET tools
skills/                 # Sanity Context agent skills (installed from sanity-io/context)
```
