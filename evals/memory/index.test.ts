import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner } from "@deepagents/evals";

const runner = getDefaultRunner();

ls.describe(
  "deepagents-js-memory",
  () => {
    ls.test(
      "memory basic recall",
      {
        inputs: {
          query:
            "What is the name of this project? Answer with just the project name.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ memory: ["/project/AGENTS.md"] })
          .run({
            query: inputs.query,
            initialFiles: {
              "/project/AGENTS.md": "Project name: TurboWidget",
            },
          });

        expect(result).toHaveFinalTextContaining("TurboWidget");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "memory guided behavior naming convention",
      {
        inputs: {
          query:
            "Create a configuration file for API settings at /api.txt with content 'API_KEY=secret'.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ memory: ["/project/AGENTS.md"] })
          .run({
            query: inputs.query,
            initialFiles: {
              "/project/AGENTS.md":
                "Naming convention: All configuration files must use the prefix 'config_' in their filename. For example, a database config should be named 'config_database.txt'.",
            },
          });

        expect(result.files["/config_api.txt"]).toContain("API_KEY=secret");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "memory influences file content",
      {
        inputs: {
          query:
            "Write a simple Python function that adds two numbers to /add.py. Keep it minimal.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ memory: ["/style/AGENTS.md"] })
          .run({
            query: inputs.query,
            initialFiles: {
              "/style/AGENTS.md":
                "Code style guide: Every Python function must start with a '# Purpose:' comment describing what it does.",
            },
          });

        expect(result.files["/add.py"]).toContain("# Purpose:");
        expect(result.files["/add.py"]).toContain("def ");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "memory multiple sources combined",
      {
        inputs: {
          query:
            "What programming language do I prefer and what framework does the project use? Be concise.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({
            memory: ["/user/AGENTS.md", "/project/AGENTS.md"],
          })
          .run({
            query: inputs.query,
            initialFiles: {
              "/user/AGENTS.md":
                "User preferences: My preferred programming language is Python.",
              "/project/AGENTS.md":
                "Project stack: This project uses the FastAPI framework for building APIs.",
            },
          });

        expect(result).toHaveFinalTextContaining("Python", true);
        expect(result).toHaveFinalTextContaining("FastAPI", true);
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "memory with missing file graceful",
      {
        inputs: {
          query: "What is 5 + 3? Answer with just the number.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ memory: ["/missing/AGENTS.md"] })
          .run({ query: inputs.query });

        expect(result).toHaveFinalTextContaining("8");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "memory prevents unnecessary file reads",
      {
        inputs: {
          query: "What are the API endpoints? List them briefly.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ memory: ["/docs/AGENTS.md"] })
          .run({
            query: inputs.query,
            initialFiles: {
              "/docs/AGENTS.md":
                "API Documentation:\n- GET /users - List all users\n- POST /users - Create a user\n- GET /users/:id - Get user by ID",
              "/docs/api.md":
                "API Documentation:\n- GET /users - List all users\n- POST /users - Create a user\n- GET /users/:id - Get user by ID",
            },
          });

        expect(result).toHaveFinalTextContaining("/users", true);
        expect(result).toHaveFinalTextContaining("GET", true);
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
