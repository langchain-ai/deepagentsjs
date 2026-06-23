import { createFramework } from "../../src/registry/framework.js";

export const next = createFramework({
  id: "next",
  title: "Next.js",
  defaultProjectName: "next-deepagents",
  frameworkDir: "next",
  envFilePath: ".env.local",
  packageJsonPath: "package.json",
  agentPath: "lib/agent",
  files: [],
});
