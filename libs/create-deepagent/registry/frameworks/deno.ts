import { createFramework } from "../../src/registry/framework.js";
import { resolveFrameworkDir } from "../../src/utils/fileUtils.js";

export const deno = createFramework({
  id: "deno",
  title: "Deno",
  defaultProjectName: "deno-deepagents",
  address: { scheme: "local", path: resolveFrameworkDir("deno") },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "server/agent",
  files: [],
});
