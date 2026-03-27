/**
 * Minimal Agent Protocol Server
 *
 * An independent implementation of the Agent Protocol REST API backed by any
 * LangGraph agent. No LangSmith account, no Postgres, no Redis — just an
 * in-memory task store and your agent.
 *
 * Implements the endpoints the DeepAgents async subagent middleware calls:
 *   POST   /threads                              → create thread
 *   POST   /threads/:threadId/runs               → create run (start or update/interrupt)
 *   GET    /threads/:threadId/runs/:runId        → get run status
 *   GET    /threads/:threadId/state              → get thread state (output)
 *   POST   /threads/:threadId/runs/:runId/cancel → cancel run
 *   GET    /ok                                   → health check
 *
 * Run:
 *   ANTHROPIC_API_KEY=... tsx examples/agent-protocol-server/server.ts
 *
 * Then point your supervisor at:
 *   RESEARCHER_URL=http://localhost:2024
 */
import "dotenv/config";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── In-memory store ──────────────────────────────────────────────────────────

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

const threads = new Map<string, Thread>();
const runs = new Map<string, Run>();

// ── Agent ────────────────────────────────────────────────────────────────────

// Web search stub — replace with Tavily if TAVILY_API_KEY is set
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
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.content}\n   ${r.url}`)
        .join("\n\n");
    }
    return [
      `Search results for "${query}":`,
      `1. Key finding: Recent developments show significant progress in ${query}`,
      `2. Expert analysis: Industry leaders are investing heavily in ${query}`,
      `3. Market data: The ${query} sector is projected to grow 25% annually`,
    ].join("\n");
  },
  {
    name: "web_search",
    description: "Search the web for information.",
    schema: z.object({ query: z.string() }),
  },
);

const researcher = createDeepAgent({
  systemPrompt:
    "You are a thorough research agent. Investigate topics using web search and produce " +
    "a well-structured research summary (300-500 words). If you receive new instructions " +
    "mid-conversation, immediately follow them without asking for clarification.",
  tools: [webSearch],
});

// ── Run executor ─────────────────────────────────────────────────────────────

async function executeRun(run: Run, thread: Thread, input: string): Promise<void> {
  run.status = "running";
  try {
    const result = await researcher.invoke({
      messages: [new HumanMessage(input)],
    });

    const lastMessage = result.messages[result.messages.length - 1];
    thread.output = typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

    thread.messages.push({ role: "assistant", content: thread.output });
    run.status = "success";
  } catch (e) {
    run.status = "error";
    run.error = String(e);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/ok", (_req, res) => {
  res.json({ ok: true });
});

// Create thread
app.post("/threads", (_req, res) => {
  const thread: Thread = {
    thread_id: uuidv4(),
    created_at: new Date().toISOString(),
    messages: [],
    output: null,
  };
  threads.set(thread.thread_id, thread);
  res.json(thread);
});

// Create run (start or interrupt/update)
app.post("/threads/:threadId/runs", (req, res) => {
  const thread = threads.get(req.params.threadId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const { input, assistant_id, multitask_strategy } = req.body as {
    input?: { messages?: { role: string; content: string }[] };
    assistant_id?: string;
    multitask_strategy?: string;
  };

  // If interrupt — cancel any running runs on this thread
  if (multitask_strategy === "interrupt") {
    for (const run of runs.values()) {
      if (run.thread_id === req.params.threadId && run.status === "running") {
        run.status = "cancelled";
      }
    }
    // Reset thread output for the new task
    thread.output = null;
  }

  const userMessage = input?.messages?.find((m) => m.role === "user")?.content ?? "";
  thread.messages.push({ role: "user", content: userMessage });

  const run: Run = {
    run_id: uuidv4(),
    thread_id: req.params.threadId,
    assistant_id: assistant_id ?? "researcher",
    status: "pending",
    created_at: new Date().toISOString(),
  };
  runs.set(run.run_id, run);

  // Execute in background — don't await
  executeRun(run, thread, userMessage);

  res.json(run);
});

// Get run status
app.get("/threads/:threadId/runs/:runId", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || run.thread_id !== req.params.threadId) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

// Get thread state (output)
app.get("/threads/:threadId/state", (req, res) => {
  const thread = threads.get(req.params.threadId);
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }
  res.json({
    values: {
      messages: thread.messages,
      output: thread.output,
    },
    next: [],
    metadata: {},
  });
});

// Cancel run
app.post("/threads/:threadId/runs/:runId/cancel", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run || run.thread_id !== req.params.threadId) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  run.status = "cancelled";
  res.json(run);
});

// List runs (used by list_async_tasks)
app.get("/runs", (_req, res) => {
  res.json(Array.from(runs.values()));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 2024;
app.listen(PORT, () => {
  console.log(`Agent Protocol server listening on http://localhost:${PORT}`);
  console.log(`Graphs: researcher`);
});
