import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { v4 as uuidv4 } from "uuid";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatAnthropic } from "@langchain/anthropic";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "./index.js";
import { FilesystemBackend } from "../backends/index.js";
import { createSummarizationMiddleware } from "../middleware/index.js";

const SYSTEM_PROMPT = `## File Reading Best Practices

When exploring codebases or reading multiple files, use pagination to prevent context overflow.

**Pattern for codebase exploration:**
1. First scan: read_file(path, limit=100) - See file structure and key sections
2. Targeted read: read_file(path, offset=100, limit=200) - Read specific sections if needed
3. Full read: Only use read_file(path) without limit when necessary for editing

**When to paginate:**
- Reading any file >500 lines
- Exploring unfamiliar codebases (always start with limit=100)
- Reading multiple files in sequence

**When full read is OK:**
- Small files (<500 lines)
- Files you need to edit immediately after reading`;

function generateLargeFile(numLines: number): string {
  const lines: string[] = [
    "from __future__ import annotations",
    "",
    "import logging",
    "import json",
    "import os",
    "import sys",
    "import re",
    "import base64",
    "from typing import Any, Optional, List, Dict",
    "from dataclasses import dataclass, field",
    "",
    "",
    'logger = logging.getLogger(__name__)',
    "",
    "",
    "@dataclass",
    "class SummarizationConfig:",
    '    """Configuration for the summarization middleware."""',
    "    max_tokens: int = 128000",
    "    trigger_fraction: float = 0.85",
    "    keep_fraction: float = 0.10",
    "    summary_prompt: str = 'Summarize the conversation.'",
    "",
    "",
  ];

  for (let i = lines.length; i < numLines; i++) {
    const mod = i % 10;
    if (mod === 0) {
      lines.push("");
      lines.push(`def function_${i}(arg1: str, arg2: int = 0) -> str:`);
    } else if (mod === 1) {
      lines.push(
        `    """Docstring for function at line ${i}. Performs computation ${i}."""`,
      );
    } else if (mod === 2) {
      lines.push(`    result = arg1 * arg2 + ${i}`);
    } else if (mod === 3) {
      lines.push(`    logger.info("Processing step %d", ${i})`);
    } else if (mod === 4) {
      lines.push(`    if result > ${i * 2}:`);
    } else if (mod === 5) {
      lines.push(`        return f"overflow at {result}"`);
    } else if (mod === 6) {
      lines.push(`    for j in range(${mod}):`);
    } else if (mod === 7) {
      lines.push(`        result += j * ${i}`);
    } else if (mod === 8) {
      lines.push(`    return str(result)`);
    } else {
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

function setupSummarizationTest(maxInputTokens: number): {
  agent: ReturnType<typeof createDeepAgent>;
  rootPath: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-eval-"));
  fs.writeFileSync(
    path.join(tmpDir, "summarization.py"),
    generateLargeFile(1000),
  );

  const backend = new FilesystemBackend({
    rootDir: tmpDir,
    virtualMode: true,
  });

  const model = new ChatAnthropic({ model: "claude-sonnet-4-5-20250929" });

  const checkpointer = new MemorySaver();

  const tokenTrigger = Math.floor(maxInputTokens * 0.85);
  const tokenKeep = Math.floor(maxInputTokens * 0.1);
  const summarizationMiddleware = createSummarizationMiddleware({
    model,
    backend,
    trigger: { type: "tokens", value: tokenTrigger },
    keep: { type: "tokens", value: tokenKeep },
    truncateArgsSettings: {
      trigger: { type: "tokens", value: tokenTrigger },
      keep: { type: "tokens", value: tokenKeep },
    },
  });

  const agent = createDeepAgent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    backend,
    checkpointer,
    middleware: [summarizationMiddleware],
  });

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { agent, rootPath: tmpDir, cleanup };
}

ls.describe("deepagents-js-summarization", () => {
  ls.test(
    "summarization: continues task after summarization",
    {
      inputs: {
        query:
          "Can you read the entirety of summarization.py, 500 lines at a time, and summarize it?",
      },
    },
    async ({ inputs }) => {
      const { agent, cleanup } = setupSummarizationTest(15_000);

      try {
        const threadId = uuidv4();
        const config = { configurable: { thread_id: threadId } };

        const result = await agent.invoke(
          { messages: [{ role: "user", content: inputs.query }] },
          config,
        );

        const state = (await agent.getState(config)) as any;
        expect(state.values._summarizationEvent).toBeDefined();

        let maxLineSeen = 0;
        let reachedEof = false;

        for (const msg of result.messages) {
          if (msg._getType?.() !== "tool") continue;
          const content =
            typeof msg.content === "string" ? msg.content : "";

          if (content.includes("exceeds file length")) {
            reachedEof = true;
          }

          const lineMatches = content.matchAll(/^\s*(\d+)\t/gm);
          for (const match of lineMatches) {
            const lineNum = parseInt(match[1], 10);
            if (lineNum > maxLineSeen) maxLineSeen = lineNum;
          }
        }

        expect(
          maxLineSeen >= 959 || reachedEof,
        ).toBe(true);
      } finally {
        cleanup();
      }
    },
  );

  ls.test(
    "summarization: offloads to filesystem",
    {
      inputs: {
        query:
          "Can you read the entirety of summarization.py, 500 lines at a time, and summarize it?",
      },
    },
    async ({ inputs }) => {
      const { agent, rootPath, cleanup } = setupSummarizationTest(15_000);

      try {
        const threadId = uuidv4();
        const config = { configurable: { thread_id: threadId } };

        await agent.invoke(
          { messages: [{ role: "user", content: inputs.query }] },
          config,
        );

        const state = (await agent.getState(config)) as any;
        expect(state.values._summarizationEvent).toBeDefined();

        const conversationHistoryRoot = path.join(
          rootPath,
          "conversation_history",
        );
        expect(fs.existsSync(conversationHistoryRoot)).toBe(true);

        const historyFile = path.join(
          conversationHistoryRoot,
          `${threadId}.md`,
        );
        expect(fs.existsSync(historyFile)).toBe(true);

        const content = fs.readFileSync(historyFile, "utf-8");
        expect(content).toContain("## Summarized at");
        expect(
          content.includes("Human:") || content.includes("AI:"),
        ).toBe(true);

        const summaryMessage =
          state.values._summarizationEvent.summaryMessage;
        expect(
          typeof summaryMessage.content === "string"
            ? summaryMessage.content
            : "",
        ).toContain("conversation_history");
        expect(
          typeof summaryMessage.content === "string"
            ? summaryMessage.content
            : "",
        ).toContain(`${threadId}.md`);

        const followupResult = await agent.invoke(
          {
            messages: [
              {
                role: "user",
                content:
                  "What is the first standard library import in summarization.py? (After the `from __future__` import.) Check the conversation history if needed.",
              },
            ],
          },
          config,
        );

        const lastMsg =
          followupResult.messages[followupResult.messages.length - 1];
        const finalAnswer =
          typeof lastMsg.content === "string" ? lastMsg.content : "";
        expect(finalAnswer.toLowerCase()).toContain("logging");
      } finally {
        cleanup();
      }
    },
  );
});
