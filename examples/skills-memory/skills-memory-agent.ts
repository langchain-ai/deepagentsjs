/* eslint-disable no-console */
/**
 * Skills + Memory Agent Example
 *
 * This example demonstrates how to use the Skills and Agent Memory middleware
 * to create an agent with:
 * - Discoverable skills from SKILL.md files
 * - Persistent long-term memory from agent.md files
 *
 * To run this example:
 *   npx tsx examples/skills-memory/skills-memory-agent.ts
 *
 * Prerequisites:
 *   - Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable
 *   - Optionally create skills in ~/.deepagents/my-agent/skills/
 *   - Optionally create agent.md in ~/.deepagents/my-agent/
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import path from "node:path";

import {
  createDeepAgent,
  createSettings,
  createSkillsMiddleware,
  createAgentMemoryMiddleware,
  listSkills,
} from "../../src/index.js";

// Configuration
const AGENT_NAME = "my-agent";

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

  // Get skills directories
  const userSkillsDir = settings.getUserSkillsDir(AGENT_NAME);
  const projectSkillsDir = settings.getProjectSkillsDir();

  console.log("🛠️  Skills directories:");
  console.log(`   User skills: ${userSkillsDir}`);
  console.log(
    `   Project skills: ${projectSkillsDir || "(not in a project)"}\n`,
  );

  // List available skills
  const skills = listSkills({
    userSkillsDir,
    projectSkillsDir,
  });

  if (skills.length > 0) {
    console.log("📚 Available skills:");
    for (const skill of skills) {
      console.log(
        `   - ${skill.name} (${skill.source}): ${skill.description.slice(0, 60)}...`,
      );
    }
    console.log();
  } else {
    console.log("📚 No skills found. You can create skills in:");
    console.log(`   - ${userSkillsDir}/{skill-name}/SKILL.md`);
    if (projectSkillsDir) {
      console.log(`   - ${projectSkillsDir}/{skill-name}/SKILL.md`);
    }
    console.log();
  }

  // Get memory paths
  const userMemoryPath = settings.getUserAgentMdPath(AGENT_NAME);
  const projectMemoryPath = settings.getProjectAgentMdPath();

  console.log("🧠 Memory locations:");
  console.log(`   User memory: ${userMemoryPath}`);
  console.log(
    `   Project memory: ${projectMemoryPath || "(not in a project)"}\n`,
  );

  // Create the model
  const model = process.env.ANTHROPIC_API_KEY
    ? new ChatAnthropic({ model: "claude-sonnet-4-20250514" })
    : new ChatOpenAI({ model: "gpt-4o-mini" });

  console.log(
    `🤖 Using model: ${process.env.ANTHROPIC_API_KEY ? "Claude" : "GPT-4o-mini"}\n`,
  );

  // Create middleware stack
  // Note: createDeepAgent already includes FilesystemMiddleware by default
  const skillsMiddleware = createSkillsMiddleware({
    skillsDir: userSkillsDir,
    assistantId: AGENT_NAME,
    projectSkillsDir: projectSkillsDir || undefined,
  });

  const memoryMiddleware = createAgentMemoryMiddleware({
    settings,
    assistantId: AGENT_NAME,
  });

  // Create the agent with skills + memory middleware
  // (FilesystemMiddleware is already included by createDeepAgent)
  const agent = await createDeepAgent({
    model,
    middleware: [skillsMiddleware, memoryMiddleware],
  });

  console.log("💬 Agent ready! Asking about available skills...\n");
  console.log("─".repeat(60));

  // Test the agent
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

  console.log("\n🤖 Agent response:\n");
  console.log(lastMessage.content);
  console.log("\n" + "─".repeat(60));

  // Show how to create a skill
  console.log("\n💡 Tips:");
  console.log("\n   To add a skill, run these commands:");
  console.log(`     mkdir -p "${userSkillsDir}/my-skill"`);
  console.log(
    `     printf '%s\\n' '---' 'name: my-skill' 'description: A custom skill' '---' '' '# My Skill' '' 'Instructions...' > "${userSkillsDir}/my-skill/SKILL.md"`,
  );

  console.log("\n   To add agent memory:");
  console.log(`     mkdir -p "${path.dirname(userMemoryPath)}"`);
  console.log(
    `     printf '%s\\n' '# Agent Memory' '' 'Remember to be helpful!' > "${userMemoryPath}"`,
  );
}

main().catch(console.error);
