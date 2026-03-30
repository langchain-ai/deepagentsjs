# Async Subagent Server

A minimal self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server that exposes a DeepAgents researcher as an async subagent. Use this as a starting point for hosting your own agent on any infrastructure and connecting it to a DeepAgents supervisor.

The example includes both sides of the pattern:

- **`server.ts`** — the Hono server your subagent runs on
- **`supervisor.ts`** — an interactive REPL showing how to connect to it

## Prerequisites

- `ANTHROPIC_API_KEY` — required
- `TAVILY_API_KEY` — optional; stub search is used if not set

## Run locally

**Terminal 1 — start the server:**

```bash
cp examples/async-subagent-server/.env.example examples/async-subagent-server/.env
# fill in your API keys

cd examples
tsx async-subagent-server/server.ts
# Server listening on http://localhost:2024
```

**Terminal 2 — start the supervisor:**

```bash
cd examples
tsx async-subagent-server/supervisor.ts
```

Try these prompts in the supervisor:

```
> research the latest developments in quantum computing
> check status of <task-id>
> update <task-id> to focus on commercial applications only
> cancel <task-id>
> list all tasks
```

## Run with Docker

Build from the repo root (required because `deepagents` is a workspace dependency):

```bash
docker build -f examples/async-subagent-server/Dockerfile -t async-subagent-server .

docker run -p 2024:2024 \
  -e ANTHROPIC_API_KEY=your-key \
  -e TAVILY_API_KEY=your-key \
  async-subagent-server
```

Then run the supervisor locally pointing at the container:

```bash
RESEARCHER_URL=http://localhost:2024 tsx examples/async-subagent-server/supervisor.ts
```

## Implemented endpoints

These are the Agent Protocol endpoints the DeepAgents async subagent middleware calls:

| Endpoint | Purpose |
|---|---|
| `POST /threads` | Create a thread for a new task |
| `POST /threads/:threadId/runs` | Start or interrupt+restart a run |
| `GET /threads/:threadId/runs/:runId` | Poll run status |
| `GET /threads/:threadId/state` | Fetch final output |
| `POST /threads/:threadId/runs/:runId/cancel` | Cancel a run |
| `GET /ok` | Health check |

## Swap in your own agent

Find the `createDeepAgent` call in `server.ts` and replace it with your own agent definition. The Agent Protocol layer — threads, runs, status polling — stays the same regardless of what the agent does.

```ts
const agent = createDeepAgent({
  systemPrompt: "You are a ...",
  tools: [yourTool],
});
```

For production, replace the in-memory `threads` and `runs` Maps with a persistent store. The HTTP surface of the server does not change.
