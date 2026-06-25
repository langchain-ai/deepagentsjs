import { createFramework } from "../../src/registry/framework.js";
import { resolveFrameworkDir } from "../../src/utils/fileUtils.js";

export const vite = createFramework({
  id: "react-vite",
  title: "React + Vite",
  defaultProjectName: "react-deepagents",
  address: { scheme: "local", path: resolveFrameworkDir("vite") },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "agent",
  files: [],
});
