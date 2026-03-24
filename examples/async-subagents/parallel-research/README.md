# Parallel research (async subagents)

A small demo where a **supervisor** deep agent fans out **parallel async researcher** subagents (each backed by a separate LangGraph graph), streams updates in a Vite + React UI, and polls run status until tasks finish.

## Prerequisites

- Node.js and [pnpm](https://pnpm.io/)
- From the **monorepo root**: `pnpm install` (and `pnpm build` if `deepagents` has not been built yet)

## Environment

1. Copy the example env file and fill in keys:

   ```bash
   cp examples/async-subagents/parallel-research/.env.example examples/async-subagents/parallel-research/.env
   ```

2. Set **`ANTHROPIC_API_KEY`** (used by the models).

3. Optionally set **`TAVILY_API_KEY`** for real web search. Without it, the researcher uses a **stub** search implementation so the flow still runs.

## 1. Run the LangGraph dev server

From the **repository root**:

```bash
npx @langchain/langgraph-cli dev -c examples/async-subagents/parallel-research/langgraph.json
```

This loads `langgraph.json`, which registers two graphs:

- **`supervisor`** — orchestrates async researcher tasks (this is what the UI talks to).
- **`researcher`** — research subagent graph invoked asynchronously by the supervisor.

Leave this process running.

## 2. Run the web UI

In a second terminal, from the **repository root**:

```bash
pnpm --filter @examples/async-subagents-parallel-research dev
```

Or from the UI package directory:

```bash
cd examples/async-subagents/parallel-research/ui && pnpm dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Using the demo

- Normal questions are answered by the supervisor directly.
- To trigger **parallel researchers**, use wording that clearly asks for research, e.g. _“Research …”_, _“Investigate …”_, _“Deep dive into …”_ (see the supervisor system prompt in `supervisor.ts` for the full trigger behavior).
- The UI shows **researcher cards** for async tasks and can **fetch results** when a run completes.

## Project layout

| Path             | Role                                                           |
| ---------------- | -------------------------------------------------------------- |
| `supervisor.ts`  | Supervisor graph (`assistantId: "supervisor"` in the UI)       |
| `researcher.ts`  | Researcher graph (`graphId: "researcher"`)                     |
| `langgraph.json` | LangGraph CLI config for both graphs                           |
| `ui/`            | Vite + React client using `@langchain/langgraph-sdk` streaming |
