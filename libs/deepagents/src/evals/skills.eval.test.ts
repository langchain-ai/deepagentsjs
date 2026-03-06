import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createDeepAgent, runAgent, getFinalText } from "./index.js";

function skillContent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

ls.describe("deepagents-js-skills", () => {
  ls.test(
    "skills: read skill full content",
    {
      inputs: {
        query:
          "What magic number do i need for explore analysing using lunar?",
      },
      referenceOutputs: { expectedText: "ALPHA-7-ZULU" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/user/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/user/data-analysis/SKILL.md": skillContent(
            "data-analysis",
            "Step-by-step workflow for analyzing datasets using Lunar tool",
            "## Steps\n1. Load dataset\n2. Clean data\n3. Explore\n\nMagic number: ALPHA-7-ZULU\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/user/data-analysis/SKILL.md",
        },
      });
      expect(result).toHaveFinalTextContaining("ALPHA-7-ZULU");
    },
  );

  ls.test(
    "skills: read skill by name",
    {
      inputs: {
        query:
          "Read only the code-review skill and tell me the code it contains. Do not read the deployment skill.",
      },
      referenceOutputs: { expectedText: "BRAVO-LIMA" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/user/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/user/code-review/SKILL.md": skillContent(
            "code-review",
            "Guidelines for conducting thorough code reviews",
            "## Process\n1. Check correctness\n2. Review style\n\nCode: BRAVO-LIMA\n",
          ),
          "/skills/user/deployment/SKILL.md": skillContent(
            "deployment",
            "Steps for deploying applications to production",
            "## Steps\n1. Build\n2. Test\n3. Deploy\n\nCode: CHARLIE-ECHO\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/user/code-review/SKILL.md",
        },
      });
      expect(result).toHaveFinalTextContaining("BRAVO-LIMA");
      expect(getFinalText(result)).not.toContain("CHARLIE-ECHO");
    },
  );

  ls.test(
    "skills: combine two skills",
    {
      inputs: {
        query:
          "What ports do the front and backend deploys use? List them as 'frontend: X, backend: Y'.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/user/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/user/frontend-deploy/SKILL.md": skillContent(
            "frontend-deploy",
            "Deploy frontend applications to the CDN",
            "## Steps\n1. Build with npm\n2. Upload to CDN\n\nFrontend port: 3000\n",
          ),
          "/skills/user/backend-deploy/SKILL.md": skillContent(
            "backend-deploy",
            "Deploy backend services via Docker",
            "## Steps\n1. Build Docker image\n2. Push to registry\n\nBackend port: 8080\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(2);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/user/frontend-deploy/SKILL.md",
        },
      });
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/user/backend-deploy/SKILL.md",
        },
      });
      expect(result).toHaveFinalTextContaining("3000");
      expect(result).toHaveFinalTextContaining("8080");
    },
  );

  ls.test(
    "skills: update skill typo fix no read",
    {
      inputs: {
        query:
          "Fix the typo in /skills/user/testing/SKILL.md: replace the exact string 'test suiet' with 'test suite'. " +
          "Do not read the file before editing it. Edit the file directly. " +
          "After editing, do NOT add any explanation; reply DONE only.",
      },
      referenceOutputs: { expectedText: "DONE" },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/user/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/user/testing/SKILL.md": skillContent(
            "testing",
            "Guidelines for writing and running tests",
            "## Steps\n1. Write unit tests\n2. Run test suiet\n3. Check coverage\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(2);
      expect(result).toHaveToolCallRequests(1);
      expect(result).toHaveToolCallInStep(1, {
        name: "edit_file",
        argsContains: {
          file_path: "/skills/user/testing/SKILL.md",
        },
      });
      expect(result).toHaveFinalTextContaining("DONE");
      expect(result.files["/skills/user/testing/SKILL.md"]).not.toContain(
        "test suiet",
      );
      expect(result.files["/skills/user/testing/SKILL.md"]).toContain(
        "test suite",
      );
    },
  );

  ls.test(
    "skills: update skill typo fix requires read",
    {
      inputs: {
        query:
          "There is a misspelled word somewhere in /skills/user/testing/SKILL.md. Read the file, identify the typo, and fix it.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/user/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/user/testing/SKILL.md": skillContent(
            "testing",
            "Guidelines for writing and running tests",
            "## Steps\n1. Write unit tests\n2. Run test suite\n3. Chekc coverege\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(2);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/user/testing/SKILL.md",
        },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "edit_file",
        argsContains: {
          file_path: "/skills/user/testing/SKILL.md",
        },
      });
      expect(result.files["/skills/user/testing/SKILL.md"]).not.toContain(
        "coverege",
      );
      expect(result.files["/skills/user/testing/SKILL.md"]).not.toContain(
        "Chekc",
      );
    },
  );

  ls.test(
    "skills: find skill in correct path",
    {
      inputs: {
        query:
          "Update the deployment skill to add a new final step: 'Send Slack notification after deploy'. " +
          "The skill path is shown in your system prompt. Edit the file directly.",
      },
    },
    async ({ inputs }) => {
      const customAgent = createDeepAgent({
        skills: ["/skills/base/", "/skills/project/"],
      });
      const result = await runAgent(customAgent, {
        query: inputs.query,
        initialFiles: {
          "/skills/base/logging/SKILL.md": skillContent(
            "logging",
            "Structured logging guidelines for all services",
            "## Guidelines\n1. Use JSON logging\n2. Include request ID\n",
          ),
          "/skills/project/deployment/SKILL.md": skillContent(
            "deployment",
            "Steps for deploying the application to production",
            "## Steps\n1. Run CI pipeline\n2. Deploy to staging\n3. Deploy to production\n",
          ),
        },
      });

      expect(result).toHaveAgentSteps(3);
      expect(result).toHaveToolCallRequests(2);
      expect(result).toHaveToolCallInStep(1, {
        name: "read_file",
        argsContains: {
          file_path: "/skills/project/deployment/SKILL.md",
        },
      });
      expect(result).toHaveToolCallInStep(2, {
        name: "edit_file",
        argsContains: {
          file_path: "/skills/project/deployment/SKILL.md",
        },
      });
      expect(
        result.files["/skills/project/deployment/SKILL.md"],
      ).toContain("Slack notification");
      expect(
        result.files["/skills/base/logging/SKILL.md"] ?? "",
      ).not.toContain("Slack notification");
    },
  );
});
