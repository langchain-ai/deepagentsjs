/* eslint-disable no-console */
/**
 * Skills + Memory Agent Example
 *
 * This example demonstrates how to create an agent with:
 * - Discoverable skills from SKILL.md files (using the `skills` parameter)
 * - Persistent long-term memory from agent.md files (using memory middleware)
 *
 * The example creates sample skills in a temp directory so it works
 * immediately without any setup.
 *
 * To run this example:
 *   npx tsx examples/skills-memory/skills-memory-agent.ts
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createDeepAgent,
  createSettings,
  createAgentMemoryMiddleware,
  FilesystemBackend,
} from "deepagents";

// Configuration
const AGENT_NAME = "my-agent";

/**
 * Create sample skills in a directory for demonstration.
 */
function createSampleSkills(skillsDir: string): void {
  // Create web-research skill
  const webResearchDir = path.join(skillsDir, "web-research");
  fs.mkdirSync(webResearchDir, { recursive: true });
  fs.writeFileSync(
    path.join(webResearchDir, "SKILL.md"),
    `---
name: web-research
description: Structured approach to conducting thorough web research on any topic
---

# Web Research Skill

## When to Use
- User asks you to research a topic
- User needs comprehensive information gathering
- User wants to understand a subject deeply

## Workflow
1. **Define scope**: Clarify what aspects the user wants to research
2. **Search**: Use web search tools to find relevant sources
3. **Analyze**: Extract key information from sources
4. **Synthesize**: Combine findings into a coherent summary
5. **Cite**: Provide sources for all claims

## Best Practices
- Use multiple sources for verification
- Prioritize authoritative sources
- Note any conflicting information
- Summarize findings clearly
`,
  );

  // Create code-review skill
  const codeReviewDir = path.join(skillsDir, "code-review");
  fs.mkdirSync(codeReviewDir, { recursive: true });
  fs.writeFileSync(
    path.join(codeReviewDir, "SKILL.md"),
    `---
name: code-review
description: Systematic code review process with best practices and common patterns
---

# Code Review Skill

## When to Use
- User asks you to review code
- User wants feedback on implementation
- User needs help improving code quality

## Review Checklist
1. **Correctness**: Does the code do what it's supposed to?
2. **Readability**: Is the code easy to understand?
3. **Performance**: Are there any obvious inefficiencies?
4. **Security**: Are there any security concerns?
5. **Best Practices**: Does it follow language conventions?

## Common Issues to Look For
- Unused variables or imports
- Missing error handling
- Hardcoded values that should be configurable
- Missing or inadequate comments
- Inconsistent naming conventions
`,
  );

  console.log(`📁 Created sample skills in: ${skillsDir}`);
  console.log(`   - web-research: Research methodology skill`);
  console.log(`   - code-review: Code review checklist skill\n`);
}

async function main() {
  console.log("🚀 Skills + Memory Agent Example\n");

  // Create settings with project detection
  const settings = createSettings();

  console.log("📁 Environment:");
  console.log(`   User deepagents dir: ${settings.userDeepagentsDir}`);
  console.log(
    `   Project root: ${settings.projectRoot || "(not in a project)"}`,
  );
  console.log(`   Has project: ${settings.hasProject}\n`);

  // Get memory paths (for display - we'll use memory middleware)
  const userMemoryPath = settings.getUserAgentMdPath(AGENT_NAME);
  const projectMemoryPath = settings.getProjectAgentMdPath();

  console.log("🧠 Memory locations:");
  console.log(`   User memory: ${userMemoryPath}`);
  console.log(
    `   Project memory: ${projectMemoryPath || "(not in a project)"}\n`,
  );

  // Create a temporary directory with sample skills
  // In production, you would use real skill directories like:
  //   settings.getUserSkillsDir(AGENT_NAME) and settings.getProjectSkillsDir()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepagents-skills-"));
  const skillsDir = path.join(tempDir, "skills");
  createSampleSkills(skillsDir);

  try {
    // Create the model
    const model = process.env.ANTHROPIC_API_KEY
      ? new ChatAnthropic({ model: "claude-sonnet-4-20250514" })
      : new ChatOpenAI({ model: "gpt-4o-mini" });

    console.log(
      `🤖 Using model: ${process.env.ANTHROPIC_API_KEY ? "Claude" : "GPT-4o-mini"}\n`,
    );

    // Create memory middleware for long-term memory
    const memoryMiddleware = createAgentMemoryMiddleware({
      settings,
      assistantId: AGENT_NAME,
    });

    // Create the agent with skills + memory
    // - `skills` parameter loads skills from the specified paths
    // - `middleware` adds the memory middleware
    // - `backend` provides filesystem access for skills loading
    const agent = await createDeepAgent({
      model,
      backend: new FilesystemBackend({ rootDir: tempDir, virtualMode: true }),
      skills: ["/skills/"],
      middleware: [memoryMiddleware],
    });

    console.log("✅ Agent created with skills + memory\n");
    console.log("─".repeat(60));

    // Ask the agent about its skills and memory
    console.log("\n💬 Asking agent about available skills and memory...\n");

    const result = await agent.invoke({
      messages: [
        new HumanMessage(
          "What skills do you have access to? List them with their descriptions. " +
            "Also, do you have any long-term memory configured?",
        ),
      ],
    });

    // Get the last AI message
    const messages = result.messages;
    const lastMessage = messages[messages.length - 1];

    console.log("🤖 Agent response:\n");
    console.log(lastMessage.content);
    console.log("\n" + "─".repeat(60));

    // Show usage tips
    console.log("\n💡 Usage Tips:");

    console.log("\n   Skills Parameter:");
    console.log(
      "   - Pass `skills: [path1, path2]` to createDeepAgent to load skills",
    );
    console.log(
      "   - Each skill is a directory containing a SKILL.md with YAML frontmatter",
    );
    console.log(
      "   - Later sources override earlier ones for same-named skills",
    );

    console.log("\n   Production Setup:");
    console.log("   - Use createSettings() to get standard skill/memory paths");
    console.log(
      `   - User skills: ${settings.getUserSkillsDir(AGENT_NAME)}/{skill-name}/SKILL.md`,
    );
    if (settings.getProjectSkillsDir()) {
      console.log(
        `   - Project skills: ${settings.getProjectSkillsDir()}/{skill-name}/SKILL.md`,
      );
    }

    console.log("\n   Memory:");
    console.log(`   - User memory: ${userMemoryPath}`);
    console.log(
      `   - Project memory: ${projectMemoryPath || "(not available outside a project)"}`,
    );
  } finally {
    // Cleanup temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("\n🧹 Cleaned up temporary skills directory");
  }
}

main().catch(console.error);
