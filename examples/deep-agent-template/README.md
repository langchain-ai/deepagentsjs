# Deep Agent Template (Opinionated, TypeScript)

Opinionated deployment template for a Deep Agent built with [`createDeepAgent(...)`](https://github.com/langchain-ai/deepagentsjs).

## What this template gives you

- A deployable Deep Agent graph at `src/agent.ts`.
- Explicit workflow prompt (plan, delegate, critique, finalize).
- Two predefined subagents (`researcher`, `critic`).
- Human-in-the-loop interrupts on `execute` and `write_file`.
- A Node.js workflow managed by `npm` with Vitest unit + integration suites.

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Run locally:

```bash
npm run dev
```

## Scripts

```bash
npm test            # unit tests (src/**/*.test.ts, excludes .int.test.ts)
npm run test:int    # integration tests (requires ANTHROPIC_API_KEY)
npm run test:eval   # evaluation tests with LangSmith reporter
npm run lint        # prettier --check
npm run format      # prettier --write
npm run build       # langgraphjs build
```

Integration tests are skipped unless `ANTHROPIC_API_KEY` is set.

## Deploy to LangSmith

1. Push this template to a Git repository.
2. In LangSmith, create a new Deployment from that repo.
3. Set environment variables for your selected model provider and optional tracing key.
4. Deploy using the provided `langgraph.json`.

## Reference docs

- Deep Agents (JS): https://github.com/langchain-ai/deepagentsjs
- LangGraph deployment in LangSmith: https://docs.langchain.com/oss/javascript/langchain/deploy
