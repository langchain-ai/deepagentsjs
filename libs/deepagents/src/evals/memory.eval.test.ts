import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { InMemoryStore } from "@langchain/langgraph-checkpoint";
import { createDeepAgent, runAgent } from "./index.js";
import {
  CompositeBackend,
  StateBackend,
  StoreBackend,
} from "../backends/index.js";

ls.describe("deepagents-js-memory", () => {
  ls.test(
    "memory: basic recall",
    {
      inputs: {
        query: "What is the name of this project? Answer with just the project name.",
      },
      referenceOutputs: { expectedText: "TurboWidget" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/project/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/project/AGENTS.md": `# Project Memory

This is the TurboWidget project. The main goal is to process widgets efficiently.

## Key Facts
- Project name: TurboWidget
- Primary language: Python
- Test framework: pytest
`,
        },
      });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("TurboWidget");
    },
  );

  ls.test(
    "memory: guided behavior naming convention",
    {
      inputs: {
        query:
          "Create a configuration file for API settings at /api.txt with content 'API_KEY=secret'.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/project/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/project/AGENTS.md": `# Project Guidelines

## Naming Conventions
All configuration files must use the prefix "config_" followed by the purpose.
Example: config_database.txt, config_settings.txt

This rule is mandatory. If a user requests a configuration file path that does not
follow this convention (e.g., "/api.txt"), create the correctly named config file
instead (e.g., "/config_api.txt") without asking for confirmation.
`,
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "write_file",
        argsContains: { file_path: "/config_api.txt" },
      });
      expect(result.files["/config_api.txt"]).toBeDefined();
      expect(result.files["/config_api.txt"]).toContain("API_KEY=secret");
    },
  );

  ls.test(
    "memory: influences file content",
    {
      inputs: {
        query:
          "Write a simple Python function that adds two numbers to /add.py. Keep it minimal.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/style/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/style/AGENTS.md": `# Code Style Guide

## Comment Requirements
Every function must start with a comment line that says "# Purpose: " followed by a brief description.
`,
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      const content = result.files["/add.py"];
      expect(content).toContain("# Purpose:");
      expect(content).toContain("def ");
    },
  );

  ls.test(
    "memory: multiple sources combined",
    {
      inputs: {
        query:
          "What programming language do I prefer and what framework does the project use? Be concise.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/user/AGENTS.md", "/project/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/user/AGENTS.md": `# User Preferences

My preferred programming language is Python.
`,
          "/project/AGENTS.md": `# Project Info

The project uses the FastAPI framework.
`,
        },
      });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("Python", true);
      expect(result).toHaveFinalTextContaining("FastAPI", true);
    },
  );

  ls.test(
    "memory: with missing file graceful",
    {
      inputs: {
        query: "What is 5 + 3? Answer with just the number.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/missing/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
      });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
    },
  );

  ls.test(
    "memory: prevents unnecessary file reads",
    {
      inputs: {
        query: "What are the API endpoints? List them briefly.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        memory: ["/docs/AGENTS.md"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/docs/AGENTS.md": `# API Documentation

## Endpoints
- GET /users - Returns list of all users
- POST /users - Creates a new user
- GET /users/{id} - Returns a specific user
`,
          "/docs/api.md":
            "This file contains the same API documentation.",
        },
      });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("/users", true);
      expect(result).toHaveFinalTextContaining("GET", true);
    },
  );

  ls.test(
    "memory: composite backend with store",
    {
      inputs: {
        query: "What is your name?",
      },
      referenceOutputs: { expectedText: "Jackson" },
    },
    async ({ inputs }) => {
      const store = new InMemoryStore();
      const now = new Date().toISOString();
      await store.put(["filesystem"], "/AGENTS.md", {
        content: ["Your name is Jackson"],
        created_at: now,
        modified_at: now,
      });

      const customAgent = createDeepAgent({
        backend: (config) =>
          new CompositeBackend(new StateBackend(config), {
            "/memories/": new StoreBackend({ ...config, store }),
          }),
        memory: ["/memories/AGENTS.md"],
        store,
      });

      const result = await runAgent(customAgent, {
        query: inputs.query,
      });

      expect(result).toHaveAgentSteps(1);
      expect(result).toHaveToolCallRequests(0);
      expect(result).toHaveFinalTextContaining("Jackson");
    },
  );
});
