# Async Subagent Server

A self-hosted [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server that exposes a DeepAgents researcher as an async subagent. Use this as a starting point for hosting your own agent on any infrastructure and connecting it to a DeepAgents supervisor.

The example includes both sides of the pattern:

- **`server.ts`** — the Hono server your subagent runs on
- **`supervisor.ts`** — an interactive REPL showing how to connect to it

## Prerequisites

- `ANTHROPIC_API_KEY` — required
- `TAVILY_API_KEY` — optional; stub search is used if not set

## Quickstart

**1. Set up your environment:**

```bash
cd examples/async-subagent-server
cp .env.example .env
# fill in ANTHROPIC_API_KEY (and optionally TAVILY_API_KEY)
```

**2. Start the server and Postgres:**

```bash
docker compose up
```

**3. In another terminal, start the supervisor:**

```bash
cd examples
tsx async-subagent-server/supervisor.ts
```

Try these prompts:

```
> research the latest developments in quantum computing
> check status of <task-id>
> update <task-id> to focus on commercial applications only
> cancel <task-id>
> list all tasks
```

## Run locally (bring your own Postgres)

If you already have Postgres running, skip Docker Compose and point the server at your database:

```bash
cd examples
DATABASE_URL=postgres://user:pass@localhost:5432/agentdb tsx async-subagent-server/server.ts
```

The server creates the `threads` and `runs` tables automatically on startup.

Then start the supervisor in another terminal:

```bash
cd examples
tsx async-subagent-server/supervisor.ts
```

## Run with Docker (server only)

Build from the repo root (required because `deepagents` is a workspace dependency):

```bash
docker build -f examples/async-subagent-server/Dockerfile -t async-subagent-server .

docker run -p 2024:2024 \
  -e ANTHROPIC_API_KEY=your-key \
  -e TAVILY_API_KEY=your-key \
  -e DATABASE_URL=postgres://user:pass@your-db-host:5432/agentdb \
  async-subagent-server
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

Replace the `createDeepAgent` call in `server.ts` with your own agent. The Agent Protocol layer stays the same regardless of what the agent does.

```ts
const agent = createDeepAgent({
  systemPrompt: "You are a ...",
  tools: [yourTool],
});
```
