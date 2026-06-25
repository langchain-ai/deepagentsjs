import { createFramework } from "../../src/registry/framework.js";
import { resolveFrameworkDir } from "../../src/utils/fileUtils.js";

export const nuxt = createFramework({
  id: "nuxt",
  title: "Nuxt",
  defaultProjectName: "nuxt-deepagents",
  address: { scheme: "local", path: resolveFrameworkDir("nuxt") },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "server/agent",
  files: [],
});
