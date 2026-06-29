# Nuxt Deep Agent

A [Nuxt 4](https://nuxt.com) example that deploys a LangChain **deep agent** with
thread storage, history, and a subagent-aware chat UI built with
[`@langchain/vue`](https://www.npmjs.com/package/@langchain/vue).

It is a Vue/Nuxt port of the streaming-cookbook `react-custom-backend` example:
the same Agent Streaming Protocol, served from Nuxt's Nitro server engine
instead of a standalone Hono process, and consumed with Vue composables instead
of React hooks.

## What it demonstrates

- **One deployable app.** Nitro serves the Agent Streaming Protocol routes under
  `/api/threads/:id/…`; the Nuxt frontend talks to them through an
  `HttpAgentServerAdapter`. No separate backend process.
- **Thread storage & history.** The agent's in-memory `MemorySaver` checkpointer
  is the single source of truth for threads — there is no client-side cache.
  `GET /api/threads` enumerates threads from the checkpointer, `DELETE
  /api/threads/:id` drops one, and `GET|POST /state` + `POST /history` expose the
  LangGraph SDK thread-state wire shape. The sidebar is always fetched from the
  server (titles derived from each thread's first message), so restarting the
  server clears every thread.
- **Subagents.** The agent is a [`deepagents`](https://www.npmjs.com/package/deepagents)
  coordinator with no direct tools — it delegates through the `task` tool to a
  `researcher` (web search) and a `math-whiz` (calculator) subagent.
  `@langchain/vue` discovers those subagents from the stream and the UI renders a
  clickable chip per subagent; selecting one drills into its own chat view,
  scoped to its namespaced `messages` and `tools` channels via `useMessages`.
- **Token & reasoning streaming.** Assistant tokens and tool-call lifecycle
  events stream over the `messages` and `tools` channels through `useStream`. The
  coordinator runs a reasoning model over the Responses API, so its reasoning
  *summaries* (`{ type: "reasoning" }` content blocks) stream into a collapsible
  "Thinking" block that auto-expands while it streams and collapses when the turn
  settles.

## Prerequisites

```bash
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`. Nitro loads it automatically in development.

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Send the example prompt and
watch the orchestrator delegate to its subagents while their work streams into
dedicated cards.

Other commands:

```bash
pnpm build      # production build
pnpm preview    # preview the production build
pnpm typecheck  # vue-tsc over the project
```

## How it works

### Backend (`server/`)

- `server/agent/index.ts` — the `createDeepAgent` coordinator and its subagents,
  compiled with an exported `MemorySaver` checkpointer. The coordinator uses a
  reasoning model over the Responses API; the tool-using subagents use a plain
  chat-completions model (to avoid the Responses API replaying reasoning items by
  id through the checkpointer).
- `server/agent/middleware.ts` — `stripReasoningReplay`: rebuilds prior assistant
  messages from `content` + `tool_calls` so stale reasoning/function-call item
  ids are never replayed to the Responses API (which would 400). State is
  untouched, so the UI still renders each turn's reasoning.
- `server/agent/tools.ts` — mock `search_web` and `calculator` tools (offline).
- `server/utils/session.ts` — `LocalThreadSession`: buffers protocol events in a
  LangGraph `StreamChannel`, filters subscriptions with `matchesSubscription`,
  and fans matching frames out over SSE.
- `server/utils/threads.ts` — checkpointer-backed `listThreads` / `getState` /
  `updateState` / `getHistory` helpers in the LangGraph SDK wire format.
- `server/utils/serialize.ts` — converts LangChain message instances to plain
  protocol dicts for the wire.
- `server/utils/runtime.ts` — process-local singleton owning the agent, the
  shared checkpointer, and one session per thread id (plus `deleteThread`).
- `server/api/threads/index.get.ts` — `GET /api/threads`, the checkpointer-backed
  thread list.
- `server/api/threads/[threadId]/…` — Nitro route handlers for `commands`,
  `stream`, `state` (GET/POST), `history`, and `DELETE` (drop a thread).

### Frontend (`app/`)

- `app/components/ChatApp.vue` — the app shell: a thread-history sidebar, theme
  toggle, and the active conversation. Fetches the thread list from the server,
  manages switching/creating/deleting, and refreshes the sidebar whenever a run
  settles (titles/order are owned by the server).
- `app/components/ThreadHistory.vue` — the sidebar listing every server thread
  with create / select / delete actions.
- `app/components/ChatThread.vue` — keyed by thread id, builds the
  `HttpAgentServerAdapter` and calls `provideStream({ transport, threadId })`;
  descendants read it with `useStreamContext()`.
- `app/components/Chat.vue` — centered message view with the composer pinned to
  the bottom, plus the per-subagent detail view (with breadcrumb) you drill into
  by clicking a subagent chip.
- `app/components/SubagentList.vue` / `SubagentDetail.vue` — the inline subagent
  cards (built from `task` tool calls) and the scoped chat for one subagent
  (`useMessages` bound to its namespace).
- `app/components/MessageList.vue` / `MessageBubbles.vue` / `MessageBubble.vue` —
  the root chat transcript and bubble rendering. `MessageBubbles` renders each AI
  turn's reasoning as a standalone block, delegations as inline subagent cards,
  and tool calls as collapsible chips — folding the matching tool-result message
  into each chip rather than showing raw tool rows.
- `app/components/ToolCall.vue` — a collapsible tool-call chip (icon, name,
  status) whose body reveals the stringified input args and the tool output.
- `app/components/MessageReasoning.vue` — the collapsible "Thinking" reasoning
  block (brain icon + caret), auto-expanded while reasoning streams.
- `app/utils/threads.ts` — server-driven thread helpers (`fetchThreads`,
  `createThread`, `deleteThread`) plus the LangGraph SDK bootstrap.

The whole stream-driven UI runs client-side (wrapped in `<ClientOnly>`) since the
transport and SSE subscription are browser concerns.

## SDK docs

- [Vue SDK](https://www.npmjs.com/package/@langchain/vue): `useStream`,
  `provideStream` / `useStreamContext`, and the selector composables
  (`useMessages`, `useToolCalls`, `useValues`, …).
- [deepagents](https://www.npmjs.com/package/deepagents): the deep agent runtime,
  subagents, and the `task` delegation tool.
