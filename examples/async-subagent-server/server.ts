/**
 * Async Subagent Server — Agent Protocol over Hono
 *
 * A minimal self-hosted Agent Protocol server that exposes a DeepAgents
 * researcher as an async subagent. Any DeepAgents supervisor can connect
 * to this server using the AsyncSubAgent configuration.
 *
 * Implements the endpoints the DeepAgents async subagent middleware calls:
 *   POST   /threads                              → create a thread
 *   POST   /threads/:threadId/runs               → start (or interrupt+restart) a run
 *   GET    /threads/:threadId/runs/:runId        → poll run status
 *   GET    /threads/:threadId/state              → fetch final output
 *   POST   /threads/:threadId/runs/:runId/cancel → cancel a run
 *   GET    /ok                                   → health check
 *
 * State is kept in-memory (two Maps). For production, swap these for a
 * database — the Agent Protocol surface stays the same.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... tsx examples/async-subagent-server/server.ts
 *
 * Then point a DeepAgents supervisor at:
 *   RESEARCHER_URL=http://localhost:2024
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { v4 as uuidv4 } from "uuid";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Thread {
  thread_id: string;
  created_at: string;
  /** Accumulated conversation turns. */
  messages: { role: string; content: string }[];
  /** Final output written by a successful run. */
  output: string | null;
}

interface Run {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
  created_at: string;
  error?: string;
}

// ── In-memory store ───────────────────────────────────────────────────────────
//
// For production, replace these Maps with a persistent store (e.g. Postgres).
// The HTTP surface of this server does not change.

const threads = new Map<string, Thread>();
const runs = new Map<string, Run>();

// ── Agent ─────────────────────────────────────────────────────────────────────
//
// Replace this with your own agent. The only requirement is that it accepts
// a messages array and returns an object with a messages array.

const webSearch = tool(
  async ({ query }: { query: string }) => {
    if (process.env.TAVILY_API_KEY) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: 5,
        }),
      });
      const data = (await res.json()) as {
        results?: { title: string; content: string; url: string }[];
      };
      if (!data.results?.length) return `No results for "${query}"`;
      return data.results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.content}\n   Source: ${r.url}`,
        )
        .join("\n\n");
    }

    // Stub search — replace with a real search API or remove this branch.
    return [
      `[stub] Search results for "${query}":`,
      `1. Key finding: Recent developments show significant progress in ${query}`,
      `2. Expert analysis: Industry leaders are investing heavily in ${query}`,
      `3. Market data: The ${query} sector has seen notable activity this quarter`,
    ].join("\n");
  },
  {
    name: "web_search",
    description:
      "Search the web for information. Use this to find current data, news, and analysis.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

// Agent is created once at startup and reused across all requests.
const agent = createDeepAgent({
  systemPrompt:
    "You are a thorough research agent. Investigate topics using web search and produce " +
    "a well-structured research summary (300–500 words). Cite sources where possible.\n\n" +
    "If you receive new instructions mid-conversation, follow them immediately without " +
    "asking for clarification — discard prior work and start fresh on the new task.",
  tools: [webSearch],
});

// ── Run executor ──────────────────────────────────────────────────────────────

async function executeRun(
  run: Run,
  thread: Thread,
  input: string,
): Promise<void> {
  run.status = "running";
  try {
    const result = await agent.invoke({
      messages: [new HumanMessage(input)],
    });

    const lastMessage = result.messages[result.messages.length - 1];
    const output =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    thread.output = output;
    thread.messages.push({ role: "assistant", content: output });
    run.status = "success";
  } catch (e) {
    run.status = "error";
    run.error = String(e);
    console.error(`[run ${run.run_id}] error:`, e);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use(logger());

// Health check
app.get("/ok", (c) => c.json({ ok: true }));

// Create a thread.
// Called by start_async_task before creating a run.
app.post("/threads", (c) => {
  const thread: Thread = {
    thread_id: uuidv4(),
    created_at: new Date().toISOString(),
    messages: [],
    output: null,
  };
  threads.set(thread.thread_id, thread);
  return c.json(thread);
});

// Create a run on an existing thread.
//
// Called by both start_async_task (new task) and update_async_task
// (re-run with new instructions). When multitask_strategy is "interrupt",
// any currently-running runs on the thread are cancelled and the thread
// output is cleared before the new run starts.
app.post("/threads/:threadId/runs", async (c) => {
  const thread = threads.get(c.req.param("threadId"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const body = await c.req.json<{
    input?: { messages?: { role: string; content: string }[] };
    assistant_id?: string;
    multitask_strategy?: string;
  }>();

  // interrupt strategy: cancel running runs, reset output for the new task.
  if (body.multitask_strategy === "interrupt") {
    for (const run of runs.values()) {
      if (run.thread_id === thread.thread_id && run.status === "running") {
        run.status = "cancelled";
      }
    }
    thread.output = null;
  }

  const userMessage =
    body.input?.messages?.find((m) => m.role === "user")?.content ?? "";
  thread.messages.push({ role: "user", content: userMessage });

  const run: Run = {
    run_id: uuidv4(),
    thread_id: thread.thread_id,
    assistant_id: body.assistant_id ?? "researcher",
    status: "pending",
    created_at: new Date().toISOString(),
  };
  runs.set(run.run_id, run);

  // Fire and forget — client polls GET /threads/:threadId/runs/:runId for status.
  executeRun(run, thread, userMessage);

  return c.json(run);
});

// Get run status.
// Called by check_async_task to poll whether a task has finished.
app.get("/threads/:threadId/runs/:runId", (c) => {
  const run = runs.get(c.req.param("runId"));
  if (!run || run.thread_id !== c.req.param("threadId")) {
    return c.json({ error: "Run not found" }, 404);
  }
  return c.json(run);
});

// Get thread state (final output).
// Called by check_async_task after a run reaches "success" status.
// The middleware reads values.messages[last].content as the task result.
app.get("/threads/:threadId/state", (c) => {
  const thread = threads.get(c.req.param("threadId"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json({
    values: {
      messages: thread.messages,
    },
    next: [],
    metadata: {},
  });
});

// Cancel a run.
// Called by cancel_async_task. In-memory cancellation only — the agent
// invocation is not interrupted mid-flight. For true cancellation, wire
// in an AbortController or use a job queue.
app.post("/threads/:threadId/runs/:runId/cancel", (c) => {
  const run = runs.get(c.req.param("runId"));
  if (!run || run.thread_id !== c.req.param("threadId")) {
    return c.json({ error: "Run not found" }, 404);
  }
  run.status = "cancelled";
  return c.json(run);
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 2024);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Agent Protocol server listening on http://localhost:${PORT}`);
  console.log(`Agents: researcher`);
  if (!process.env.TAVILY_API_KEY) {
    console.log(
      `[warn] TAVILY_API_KEY not set — using stub search. Set it for real web search.`,
    );
  }
});
