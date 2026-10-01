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
   pnpm install
   ```

2. Create `.env` from the example and fill it in:

   ```sh
   cp .env.example .env
   ```

   At minimum you need `GOOGLE_GENERATIVE_AI_API_KEY`, `SANITY_API_TOKEN`, and `AGENT_API_TOKEN`. Generate the last one with `openssl rand -base64 32` and put the same value in `web/.env`.

3. Start the server with file watching:

   ```sh
   pnpm dev
   ```

   It listens on `http://localhost:8787` by default.

## Commands

| Command          | Action                                             |
| ---------------- | -------------------------------------------------- |
| `pnpm dev`       | Start with `node --watch`, loading `.env` if present |
| `pnpm start`     | Start without watching                             |
| `pnpm typecheck` | Type-check with `tsc` (no emit)                    |

## HTTP API

| Method    | Path      | Auth           | Description                                                  |
| --------- | --------- | -------------- | ------------------------------------------------------------ |
| `POST`    | `/chat`      | Bearer token   | Run the Career Explorer agent and stream an AI SDK UI message stream back |
| `POST`    | `/interview` | Bearer token   | Run the Mock Interview Coach agent (same body and response format)        |
| `POST`    | `/quiz`      | Bearer token   | Run the Interest Quiz agent (same body and response format)               |
| `GET`     | `/health`    | none           | Returns `{"ok":true}`                                                     |
| `OPTIONS` | any          | none           | CORS preflight                                                            |

The `POST` routes expect the body that AI SDK's `useChat` sends: `{ id, messages }`, where `messages` is an array of UI messages. On `/chat`, `id` is optional, but when present it's used as the Conversation Insights thread id. `/interview` and `/quiz` don't record Insights.

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
| `GEMINI_MODEL`                 | no       | `gemini-3.8-flash`                   | Gemini model id                                                      |
| `PORT`                         | no       | `8787`                               | HTTP port                                                            |
| `ALLOWED_ORIGINS`              | no       | `http://localhost:4321`              | Comma-separated browser origins that get CORS headers                |
| `SANITY_PROJECT_ID`            | no       | `rhq335ze`                           | Sanity project                                                       |
| `SANITY_DATASET`               | no       | `production`                         | Sanity dataset                                                       |
| `SANITY_CONTEXT_MCP_URL`       | no       | dataset-addressed legacy endpoint    | Override for an org-level Context MCP endpoint                       |
| `SANITY_COACHING_MCP_URL`      | no       | none                                 | Context MCP endpoint serving the coaching Knowledge Base (Mock Interview Coach) |
| `SANITY_COACHING_TOKEN`        | no       | `SANITY_API_TOKEN`                   | Organization token with Context access for the coaching endpoint     |
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
5. `explorer-agent.ts` builds a `ToolLoopAgent` with the local O\*NET tools, the MCP tools, the system prompt, and the optional Insights integration. It stops after 12 steps.
6. `pipeAgentUIStreamToResponse` streams the result to the response and closes the MCP client when done.

## Tools

The local tools in `src/onet/data.ts` run GROQ directly against the public O\*NET dataset (CDN, no token). The system prompt tells the model to prefer them.

| Tool                     | Input                              | Returns                                                                   |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------- |
| `searchOccupations`      | `query`, `maxJobZone?`, `limit`    | Occupations ranked by keyword and semantic match (see below), excluding "All Other" and military |
| `getOccupationProfile`   | `code`                             | Description, Job Zone, education, core tasks, top skills/knowledge/abilities/activities, work styles, hot technologies |
| `compareOccupations`     | `fromCode`, `toCode`               | Skill/knowledge/ability gaps, shared strengths, Job Zone change, new technologies |
| `getRelatedOccupations`  | `code`, `limit`                    | Related occupations ordered by O\*NET relatedness tier                    |

Codes are O\*NET-SOC codes like `15-2051.00`. Every result includes an `onetonline.org` URL the model uses for links.

`searchOccupations` runs two GROQ queries in parallel: a keyword ranking (`match` on title, alternate titles, and description) and a semantic ranking (`text::semanticSimilarity()`), then merges them with reciprocal rank fusion. Job titles still surface through the keyword ranking, and descriptions like "working outdoors with animals" match by meaning even with no shared words. The semantic ranking needs [dataset embeddings](https://www.sanity.io/docs/content-lake/dataset-embeddings) on `production`, enabled with a projection limited to `onetOccupation` (title, description, alternate titles, tasks); check with `npx sanity datasets embeddings status production`. Each search uses one query from the organization's monthly semantic search quota. If the semantic query fails, the tool logs a warning and returns keyword results only.

The Sanity Context MCP server adds `groq_query` and `schema_explorer` for questions the local tools don't cover.

## Mock Interview Coach

`POST /interview` runs a separate `ToolLoopAgent` defined in `src/interview-agent.ts`. It uses the local tools below, plus the coaching Knowledge Base when it's configured. It stops after 6 steps per turn (9 with the Knowledge Base) and keeps interview state in the conversation itself. The first user message carries the setup: target job, number of questions, and focus (`mixed`, `behavioral`, or `skills`).

| Tool                 | Input                          | Returns                                                                        |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `searchOccupations`  | same as the explorer tool      | Matching occupations                                                           |
| `getInterviewBrief`  | `code`                         | Core tasks, technologies, work styles, and top skills/work activities/knowledge with importance, required level, and Level Scale Anchors (`src/onet/interview.ts`) |
| `scoreAnswer`        | the model's assessment         | Echoes the input. The UI renders it as a feedback card                         |
| `finishInterview`    | the model's final report       | Echoes the input. The UI renders it as a report card                           |

Level Scale Anchors are O\*NET's concrete examples of what level 2, 4, and 6 look like on the 0–7 Level scale (for example, Programming at level 2 is "Write a program to sort objects in a database"). The coach pitches questions at each competency's required level and grades answers by comparing them with these anchors.

`scoreAnswer` and `finishInterview` exist to give the UI structured output. If you change their input schemas, update the matching types in `web/src/components/InterviewCoach.tsx`.

### Coaching Knowledge Base

Career counselors write interview coaching guidance as `coachingGuide` documents in Studio: answer structure, question types, the rating rubric, feedback, candidate situations, and practice ideas. A Sanity Context Knowledge Base imports the published guides and builds them into an outline of entries, flagging guides that contradict each other. The coach gets the outline in its system prompt and reads entries through the endpoint's MCP tools before asking, scoring, and writing the report.

The O\*NET brief stays the source of truth for what the job requires. The guidance only shapes how the coach asks, grades, and gives feedback. If `SANITY_COACHING_MCP_URL` is unset or the endpoint can't be reached, the coach runs exactly as before.

Knowledge Bases are in beta. `pnpm kb:coaching` prints source usage against the limit (16 of 5,000 for this organization). Keep guides focused anyway: the build merges overlapping guides into one entry (the 16 starter guides became 12 entries) and raises conflict issues when they disagree.

Setup:

1. Deploy the Studio so the Coaching Guide type shows up for editors (`cd ../studio && pnpm run deploy`), then seed the starter guides: `pnpm seed:coaching` (add `--dry-run` to preview). The script skips guides whose title already exists, so edits in Studio are never overwritten.
2. Create and build the Knowledge Base: `pnpm kb:coaching` in `studio/`. The first run prints a `COACHING_KB_ID` to save in `studio/.env`. Later runs refresh it, re-reading the guides and filing change issues. It also turns on a weekly refresh. Review any open issues (such as conflicting guidance) in the Sanity dashboard under Context → Knowledge Bases.
3. In the Sanity dashboard, open Context → MCP endpoints and create an endpoint (for example `interview-coaching`) with **Content source: Knowledge base**, pointing at "Interview coaching guidance".
4. Set `SANITY_COACHING_MCP_URL` to that endpoint's URL. If `SANITY_API_TOKEN` isn't an organization token with Context access, also set `SANITY_COACHING_TOKEN`.

The UI labels the Knowledge Base's tool calls through `PREP_LABELS` in `web/src/components/InterviewCoach.tsx`. If the endpoint exposes tool names other than `initial_context` and `knowledge_base_read`, add them there.

## Interest Quiz

`POST /quiz` runs a `ToolLoopAgent` defined in `src/quiz-agent.ts`. It follows the O\*NET Interest Profiler: users rate work activities on its 5-point scale (strongly dislike, dislike, unsure, like, strongly like), and the ratings become a RIASEC profile (Realistic, Investigative, Artistic, Social, Enterprising, Conventional) matched against every occupation's O\*NET interest scores. It stops after 8 steps per turn. The first user message carries the most preparation the user is open to, as a Job Zone or "any".

The quiz has two rounds:

1. **Broad:** the 24 illustrative activities for the six career interest types (four each), interleaved.
2. **Focused:** one random activity from each Specific Interest Area under the user's two leading types (up to 18).

| Tool                    | Input                    | Returns                                                                                   |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `getQuizActivities`     | `round`                  | `{ round, focusTypes?, activities: [{ id, text }] }`. Activity ids are `<elementId>:<index>` |
| `presentActivities`     | `round`, `intro`         | Client-side tool with no `execute`. The UI renders a rating card and returns `{ ratings: [{ id, rating }] }` with `addToolOutput` |
| `buildInterestProfile`  | none                     | Holland code, 1–7 score per type with description and keywords, liked and disliked areas   |
| `matchOccupations`      | `maxJobZone?`, `limit`   | Occupations ranked by match percent, with their interest code and the liked areas they share |
| `searchOccupations`, `getOccupationProfile`, `getRelatedOccupations` | same as the explorer tools | For follow-up questions |

Because `presentActivities` has no `execute`, the agent's turn ends when it's called. The browser collects the ratings, adds them as the tool output, and `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` sends the next request. `handleQuiz` reads every `presentActivities` output from the incoming UI messages (`ratingsFromMessages`) and passes them to the tools, so the model never copies activity ids or ratings.

Scoring (`src/onet/interests.ts`) is deterministic:

- Each rating is worth strongly dislike 0, dislike 0.25, unsure 0.5, like 0.75, strongly like 1 (`RATING_VALUE`). An area counts as liked when its mean is at least 0.75 and disliked at 0.25 or below. A type's score is `1 + 6 × mean`, on the same 1–7 scale O\*NET uses for occupations. Area activities count toward each of the area's parent types at half weight.
- The match percent is 70% the Pearson correlation of the user's and the occupation's RIASEC scores (rescaled to 0–1) and 30% how much the user liked the occupation's strongest Specific Interest Areas, weighted by how strong each area is for the occupation. Before the focused round, it's the correlation alone.
- The interest catalog (47 documents) and every occupation's interest profile (about 900) are fetched once and cached in memory. Restart the agent after re-importing interest data.

The data comes from the `interests` phase of the Studio importer (`onetInterest` documents and `onetOccupation.interestProfile`). If you change a tool's output shape, update the mirrored types in `web/src/components/InterestQuiz.tsx`.

## Conversation Insights

When `SANITY_ORGANIZATION_ID` and `SANITY_INSIGHTS_TOKEN` are set and the request includes a chat `id`, each transcript is saved to the organization's Context store under `SANITY_CONTEXT_ENDPOINT_NAME`. The scheduled `classify-conversations` Sanity Function at the repo root (`functions/`, deployed via `sanity.blueprint.ts`) classifies those transcripts weekly (Mondays at 06:00 Central, up to 500 per run), so it must use the same endpoint name.

## Project structure

```
src/
├── server.ts           # HTTP server, bearer auth, CORS, routing
├── chat.ts             # Per-request wiring for /chat, /interview, and /quiz: MCP client, agents, streaming
├── explorer-agent.ts   # Career Explorer: local tool definitions, system prompt, ToolLoopAgent factory
├── interview-agent.ts  # Mock Interview Coach: tools, scoring schemas, system prompt, agent factory
├── quiz-agent.ts       # Interest Quiz: tools, ratings extraction, system prompt, agent factory
├── env.ts              # Environment variables and defaults
├── sanity.ts           # Read-only Sanity client for the O*NET dataset
├── sanity-context.ts   # Context MCP client, per-endpoint initial-context fetch and cache
├── sanity-insights.ts  # Conversation Insights integration
└── onet/
    ├── data.ts         # GROQ queries and shaping for the O*NET tools
    ├── interview.ts    # Interview brief: competencies with Level Scale Anchors
    └── interests.ts    # Quiz activities, RIASEC scoring, occupation matching (cached catalog)
skills/                 # Sanity Context agent skills (installed from sanity-io/context)
```
