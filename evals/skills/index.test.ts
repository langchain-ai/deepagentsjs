import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { getDefaultRunner, getFinalText } from "@deepagents/evals";

const runner = getDefaultRunner();

function skillContent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

ls.describe(
  "deepagents-js-skills",
  () => {
    ls.test(
      "read skill full content",
      {
        inputs: {
          query:
            "What magic number do i need for explore analysing using lunar?",
        },
      },
      async ({ inputs }) => {
        const result = await runner.extend({ skills: ["/skills/user/"] }).run({
          query: inputs.query,
          initialFiles: {
            "/skills/user/data-analysis/SKILL.md": skillContent(
              "data-analysis",
              "Step-by-step workflow for analyzing datasets using Lunar tool",
              "## Steps\n1. Load dataset\n2. Clean data\n3. Explore\n\nMagic number: ALPHA-7-ZULU\n",
            ),
          },
        });

        expect(result).toHaveFinalTextContaining("ALPHA-7-ZULU");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "read skill by name",
      {
        inputs: {
          query:
            "Read only the code-review skill and tell me the code it contains. Do not read the deployment skill.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.extend({ skills: ["/skills/user/"] }).run({
          query: inputs.query,
          initialFiles: {
            "/skills/user/code-review/SKILL.md": skillContent(
              "code-review",
              "How to review pull requests",
              "Code: BRAVO-LIMA\n",
            ),
            "/skills/user/deployment/SKILL.md": skillContent(
              "deployment",
              "How to deploy services",
              "Code: CHARLIE-ECHO\n",
            ),
          },
        });

        expect(result).toHaveFinalTextContaining("BRAVO-LIMA");
        expect(getFinalText(result)).not.toContain("CHARLIE-ECHO");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "combine two skills",
      {
        inputs: {
          query:
            "What ports do the front and backend deploys use? List them as 'frontend: X, backend: Y'.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.extend({ skills: ["/skills/user/"] }).run({
          query: inputs.query,
          initialFiles: {
            "/skills/user/frontend-deploy/SKILL.md": skillContent(
              "frontend-deploy",
              "Frontend deployment guide",
              "Frontend port: 3000\n",
            ),
            "/skills/user/backend-deploy/SKILL.md": skillContent(
              "backend-deploy",
              "Backend deployment guide",
              "Backend port: 8080\n",
            ),
          },
        });

        expect(result).toHaveFinalTextContaining("3000");
        expect(result).toHaveFinalTextContaining("8080");
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "update skill typo fix no read",
      {
        inputs: {
          query:
            "Fix the typo in /skills/user/testing/SKILL.md: replace the exact string 'test suiet' with 'test suite'. Do not read the file before editing it. Edit the file directly.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.extend({ skills: ["/skills/user/"] }).run({
          query: inputs.query,
          initialFiles: {
            "/skills/user/testing/SKILL.md": skillContent(
              "testing",
              "How to run tests",
              "## Steps\n1. Install deps\n2. Run test suiet\n3. Check coverage\n",
            ),
          },
        });

        expect(result.files["/skills/user/testing/SKILL.md"]).not.toContain(
          "test suiet",
        );
        expect(result.files["/skills/user/testing/SKILL.md"]).toContain(
          "test suite",
        );
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "update skill typo fix requires read",
      {
        inputs: {
          query:
            "There is a misspelled word somewhere in /skills/user/testing/SKILL.md. Read the file, identify the typo, and fix it.",
        },
      },
      async ({ inputs }) => {
        const result = await runner.extend({ skills: ["/skills/user/"] }).run({
          query: inputs.query,
          initialFiles: {
            "/skills/user/testing/SKILL.md": skillContent(
              "testing",
              "How to run tests",
              "## Steps\n1. Install deps\n2. Run test suite\n3. Check covreage\n",
            ),
          },
        });

        expect(result.files["/skills/user/testing/SKILL.md"]).not.toContain(
          "covreage",
        );
        expect(result.files["/skills/user/testing/SKILL.md"]).toContain(
          "coverage",
        );
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );

    ls.test(
      "find skill in correct path",
      {
        inputs: {
          query:
            "Update the deployment skill to add a new final step: 'Send Slack notification after deploy'. The skill path is shown in your system prompt. Edit the file directly.",
        },
      },
      async ({ inputs }) => {
        const result = await runner
          .extend({ skills: ["/skills/base/", "/skills/project/"] })
          .run({
            query: inputs.query,
            initialFiles: {
              "/skills/base/logging/SKILL.md": skillContent(
                "logging",
                "How to configure logging",
                "## Steps\n1. Import logger\n2. Set log level\n",
              ),
              "/skills/project/deployment/SKILL.md": skillContent(
                "deployment",
                "How to deploy the project",
                "## Steps\n1. Build artifacts\n2. Push to registry\n3. Deploy to cluster\n",
              ),
            },
          });

        expect(result.files["/skills/project/deployment/SKILL.md"]).toContain(
          "Slack notification",
        );
        const loggingFile = result.files["/skills/base/logging/SKILL.md"];
        if (loggingFile != null) {
          expect(loggingFile).not.toContain("Slack notification");
        }
        ls.logFeedback({
          key: "agent_steps",
          score: result.steps.length,
        });
      },
    );
  },
  { projectName: runner.name, upsert: true },
);
