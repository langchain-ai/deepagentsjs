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
 * Persistence is backed by Postgres. Set DATABASE_URL in your environment:
 *
 *   DATABASE_URL=postgres://user:pass@localhost:5432/agentdb
 *
 * Schema is created automatically on startup (CREATE TABLE IF NOT EXISTS).
 * For production, swap this for a migration tool (e.g. Flyway, golang-migrate).
 *
 * Run:
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... tsx examples/async-subagent-server/server.ts
 *
 * Then point a DeepAgents supervisor at:
 *   RESEARCHER_URL=http://localhost:2024
 */
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env") });
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { v4 as uuidv4 } from "uuid";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import pkg from "pg";
import { createDeepAgent } from "deepagents";
import { HumanMessage } from "langchain";

const { Pool } = pkg;

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/agentdb",
});

/**
 * Create the threads and runs tables if they don't already exist.
 * Called once at startup before the server begins accepting requests.
 *
 * threads — one row per conversation thread
 *   messages  JSONB array of { role, content } objects
 *   output    the final assistant response (NULL until a run succeeds)
 *
 * runs — one row per run attempt on a thread
 *   status  one of: pending | running | success | error | cancelled
 */
async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id  TEXT        PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      messages   JSONB       NOT NULL DEFAULT '[]',
      output     TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id       TEXT        PRIMARY KEY,
      thread_id    TEXT        NOT NULL REFERENCES threads(thread_id),
      assistant_id TEXT        NOT NULL,
      status       TEXT        NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error        TEXT
    );
  `);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Thread {
  thread_id: string;
  created_at: string;
  messages: { role: string; content: string }[];
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

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getThread(threadId: string): Promise<Thread | null> {
  const { rows } = await pool.query<Thread>(
    "SELECT thread_id, created_at, messages, output FROM threads WHERE thread_id = $1",
    [threadId],
  );
  return rows[0] ?? null;
}

async function getRun(runId: string): Promise<Run | null> {
  const { rows } = await pool.query<Run>(
    "SELECT run_id, thread_id, assistant_id, status, created_at, error FROM runs WHERE run_id = $1",
    [runId],
  );
  return rows[0] ?? null;
}

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
  runId: string,
  threadId: string,
  input: string,
): Promise<void> {
  await pool.query("UPDATE runs SET status = 'running' WHERE run_id = $1", [
    runId,
  ]);
  try {
    const result = await agent.invoke({
      messages: [new HumanMessage(input)],
    });

    const lastMessage = result.messages[result.messages.length - 1];
    const output =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    await pool.query(
      `UPDATE threads
          SET output   = $1,
              messages = messages || $2::jsonb
        WHERE thread_id = $3`,
      [
        output,
        JSON.stringify([{ role: "assistant", content: output }]),
        threadId,
      ],
    );
    await pool.query("UPDATE runs SET status = 'success' WHERE run_id = $1", [
      runId,
    ]);
  } catch (e) {
    await pool.query(
      "UPDATE runs SET status = 'error', error = $1 WHERE run_id = $2",
      [String(e), runId],
    );
    // eslint-disable-next-line no-console
    console.error(`[run ${runId}] error:`, e);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use(logger());

// Health check
app.get("/ok", (c) => c.json({ ok: true }));

// Create a thread.
// Called by start_async_task before creating a run.
app.post("/threads", async (c) => {
  const threadId = uuidv4();
  const { rows } = await pool.query<Thread>(
    `INSERT INTO threads (thread_id) VALUES ($1)
     RETURNING thread_id, created_at, messages, output`,
    [threadId],
  );
  return c.json(rows[0]);
});

// Create a run on an existing thread.
//
// Called by both start_async_task (new task) and update_async_task
// (re-run with new instructions). When multitask_strategy is "interrupt",
// any currently-running runs on the thread are cancelled and the thread
// output is cleared before the new run starts.
app.post("/threads/:threadId/runs", async (c) => {
  const thread = await getThread(c.req.param("threadId"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const body = await c.req.json<{
    input?: { messages?: { role: string; content: string }[] };
    assistant_id?: string;
    multitask_strategy?: string;
  }>();

  // interrupt strategy: cancel running runs, reset output for the new task.
  if (body.multitask_strategy === "interrupt") {
    await pool.query(
      `UPDATE runs SET status = 'cancelled'
        WHERE thread_id = $1 AND status = 'running'`,
      [thread.thread_id],
    );
    await pool.query("UPDATE threads SET output = NULL WHERE thread_id = $1", [
      thread.thread_id,
    ]);
  }

  const userMessage =
    body.input?.messages?.find((m) => m.role === "user")?.content ?? "";

  await pool.query(
    `UPDATE threads
        SET messages = messages || $1::jsonb
      WHERE thread_id = $2`,
    [
      JSON.stringify([{ role: "user", content: userMessage }]),
      thread.thread_id,
    ],
  );

  const runId = uuidv4();
  const { rows } = await pool.query<Run>(
    `INSERT INTO runs (run_id, thread_id, assistant_id)
     VALUES ($1, $2, $3)
     RETURNING run_id, thread_id, assistant_id, status, created_at, error`,
    [runId, thread.thread_id, body.assistant_id ?? "researcher"],
  );
  const run = rows[0];

  // Fire and forget — client polls GET /threads/:threadId/runs/:runId for status.
  executeRun(run.run_id, run.thread_id, userMessage);

  return c.json(run);
});

// Get run status.
// Called by check_async_task to poll whether a task has finished.
app.get("/threads/:threadId/runs/:runId", async (c) => {
  const run = await getRun(c.req.param("runId"));
  if (!run || run.thread_id !== c.req.param("threadId")) {
    return c.json({ error: "Run not found" }, 404);
  }
  return c.json(run);
});

// Get thread state (final output).
// Called by check_async_task after a run reaches "success" status.
// The middleware reads values.messages[last].content as the task result.
app.get("/threads/:threadId/state", async (c) => {
  const thread = await getThread(c.req.param("threadId"));
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
// Called by cancel_async_task. Marks the run cancelled in the database.
// Note: the agent invocation is not interrupted mid-flight. For true
// cancellation, wire in an AbortController or use a job queue.
app.post("/threads/:threadId/runs/:runId/cancel", async (c) => {
  const run = await getRun(c.req.param("runId"));
  if (!run || run.thread_id !== c.req.param("threadId")) {
    return c.json({ error: "Run not found" }, 404);
  }
  await pool.query("UPDATE runs SET status = 'cancelled' WHERE run_id = $1", [
    run.run_id,
  ]);
  return c.json({ ...run, status: "cancelled" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 2024);

await initDb();

serve({ fetch: app.fetch, port: PORT }, () => {
  // eslint-disable-next-line no-console
  console.log(`Agent Protocol server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Agents: researcher`);
  if (!process.env.TAVILY_API_KEY) {
    // eslint-disable-next-line no-console
    console.log(
      `[warn] TAVILY_API_KEY not set — using stub search. Set it for real web search.`,
    );
  }
});
