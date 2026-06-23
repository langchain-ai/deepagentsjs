import { createFramework } from "../../src/registry/framework.js";

export const hono = createFramework({
  id: "react-vite",
  title: "React + Vite",
  defaultProjectName: "react-deepagents",
  frameworkDir: "vite",
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "agent",
  files: [],
});
