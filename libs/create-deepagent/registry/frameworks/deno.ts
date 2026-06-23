import { createFramework } from "../../src/registry/framework.js";

export const deno = createFramework({
  id: "deno",
  title: "Deno",
  defaultProjectName: "deno-deepagents",
  frameworkDir: "deno",
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "server/agent",
  files: [],
});
