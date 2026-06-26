import { createFramework } from "../../src/registry/framework.js";

export const deno = createFramework({
  id: "deno",
  title: "Deno",
  defaultProjectName: "deno-deepagents",
  address: {
    scheme: "github",
    owner: "aolsenjazz",
    repo: "deployment-cookbook",
    subPath: "js-deno",
  },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "server/agent",
  files: [],
});
