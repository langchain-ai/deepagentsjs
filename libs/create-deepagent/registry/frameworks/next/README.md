# Deploying a LangChain Agent with Next.js

An example app that deploys a LangChain **deep agent** entirely inside a Next.js
App Router project — streaming chat UI, subagents, and thread history, all backed
by the [Agent Streaming Protocol](https://github.com/langchain-ai/agent-protocol/tree/main/streaming) implemented as
Next.js Route Handlers (HTTP + SSE). No separate backend process.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flangchain-ai%2Fdeployment-cookbook&root-directory=js-next&env=OPENAI_API_KEY&envDescription=OpenAI%20API%20key%20for%20the%20agent%20and%20its%20subagents)

1. Click **Deploy with Vercel** (or import
   [`langchain-ai/deployment-cookbook`](https://github.com/langchain-ai/deployment-cookbook)
   manually).
2. Set **Root Directory** to `js-next`.
3. Add `OPENAI_API_KEY` in project settings.
4. Deploy.

That is all that is required for a first deploy. The route handlers already set
`runtime = "nodejs"` and the SSE route sets `dynamic = "force-dynamic"`, which
Vercel needs for streaming.

Optionally enable LangSmith tracing by adding the variables from
[`.env.example`](./.env.example).

## Required API endpoints

The app exposes the Agent Streaming Protocol under `/api/threads/...`. Route
handlers live in `app/api/threads/`.

### Minimum (streaming chat)

These three endpoints are enough to run a single-threaded streaming chat with
`@langchain/react`'s `HttpAgentServerAdapter`:

| Method         | Path                              | Purpose                                                        |
| -------------- | --------------------------------- | -------------------------------------------------------------- |
| `POST`         | `/api/threads/:threadId/commands` | Accept protocol commands (`run.start`, …) and start agent runs |
| `POST`         | `/api/threads/:threadId/stream`   | SSE stream of protocol events for a run                        |
| `GET` / `POST` | `/api/threads/:threadId/state`    | Read and bootstrap checkpointed thread state                   |

The client bootstraps a thread with `GET /state` (and `POST /state` on 404) so
hydration does not 404 before the first message is sent.

### Optional (this app's sidebar)

This example also implements endpoints for the thread-history sidebar. You can
omit them if your UI does not need multi-thread management:

| Method   | Path                             | Purpose                                       |
| -------- | -------------------------------- | --------------------------------------------- |
| `GET`    | `/api/threads`                   | List threads known to the checkpointer        |
| `DELETE` | `/api/threads/:threadId`         | Delete a thread's session and checkpoints     |
| `POST`   | `/api/threads/:threadId/history` | Paginated checkpoint history (Agent Protocol) |

### Request flow

```mermaid
flowchart TB
  subgraph browser["Browser"]
    SP["StreamProvider"]
    HAA["HttpAgentServerAdapter"]
    SP --- HAA
  end

  subgraph routes["Next.js Route Handlers (Node runtime)"]
    CMD["POST /api/threads/:id/commands"]
    STR["POST /api/threads/:id/stream (SSE)"]
    STA["GET|POST /api/threads/:id/state"]
  end

  subgraph server["lib/server"]
    SRV["session · threads · registry"]
  end

  subgraph agent["lib/agent"]
    AGT["createDeepAgent + checkpointer"]
  end

  HAA -->|POST| CMD
  HAA -->|POST| STR
  HAA -->|GET / POST| STA
  CMD --> SRV
  STR --> SRV
  STA --> SRV
  SRV --> AGT
```

1. Bootstrap thread state (`GET`/`POST /state`).
2. On submit, the SDK sends `run.start` to `/commands` and receives a `run_id`.
3. The SDK subscribes to `/stream` (SSE) for replay + live protocol events.
4. Subagent (`task`) runs emit namespaced events surfaced as `stream.subagents`.

## Production persistence

Out of the box, the agent uses an in-memory `MemorySaver` checkpointer
(`lib/agent/index.ts`) and a process-local session map (`lib/server/registry.ts`).
That works for local dev and single-instance servers, but on Vercel (serverless,
multiple replicas) conversation state is **not durable** across cold starts or
instances.

For production, swap in a [durable checkpointer](https://docs.langchain.com/oss/javascript/langgraph/checkpointers#checkpointer-libraries):

| Package                                    | Backend                    |
| ------------------------------------------ | -------------------------- |
| `@langchain/langgraph-checkpoint-redis`    | Redis (`RedisSaver`)       |
| `@langchain/langgraph-checkpoint-postgres` | Postgres (`PostgresSaver`) |
| `@langchain/langgraph-checkpoint-sqlite`   | SQLite (`SqliteSaver`)     |

Replace `MemorySaver` in `lib/agent/index.ts` and pass the new checkpointer to
`createDeepAgent`. The route handlers and `lib/server/threads.ts` helpers stay
the same.

### Redis on Vercel

A common choice for Vercel is Redis via the
[Marketplace](https://vercel.com/docs/redis) (for example
[Upstash Redis](https://vercel.com/marketplace/upstash)). Install the
integration on your Vercel project; credentials are injected as environment
variables automatically.

Then wire `@langchain/langgraph-checkpoint-redis`:

```ts
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";

const checkpointer = await RedisSaver.fromUrl(process.env.REDIS_URL!);
```

Use the connection string your Redis provider exposes (Upstash provides both
REST and Redis-protocol URLs — the checkpointer needs the Redis URL).

You will also want a shared session/replay store in `lib/server/registry.ts` so
SSE reconnection works across serverless invocations. The checkpointer swap is
the main step for durable thread history; the session store is a separate
concern for live-run replay.

See also: [checkpointer libraries](https://docs.langchain.com/oss/javascript/langgraph/checkpointers#checkpointer-libraries),
[add memory / persistence](https://docs.langchain.com/oss/javascript/langgraph/add-memory).

## Local development

```bash
cp .env.example .env.local   # set OPENAI_API_KEY
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
pnpm build   # production build
pnpm start   # serve the production build
pnpm lint    # eslint
```

## Project layout

- `lib/agent/` — deep agent (`createDeepAgent`) with `researcher` and `math-whiz`
  subagents and mock tools. Marked `server-only`.
- `lib/server/` — protocol server logic: `session.ts` (SSE runs),
  `threads.ts` (checkpointer-backed state), `serialize.ts`, `registry.ts`.
- `app/api/threads/` — Route Handlers for the protocol endpoints above.
- `lib/chat/threads-client.ts` — browser thread bootstrap and sidebar helpers.
- `components/` — chat UI (`ChatApp`, `Chat`, `MessageList`, `Subagents`,
  `ThreadHistory`, …).

## References

- [Agent Streaming Protocol](https://github.com/langchain-ai/agent-protocol/tree/main/streaming) — protocol spec consumed by `@langchain/react`'s `HttpAgentServerAdapter`
- [`react-custom-backend`](https://github.com/langchain-ai/streaming-cookbook) — original Vite + Hono reference for a custom protocol server
- [Next.js Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers) — API routes used for the protocol endpoints
- [`deepagents`](https://www.npmjs.com/package/deepagents) — coordinator + subagent orchestration used by this demo
