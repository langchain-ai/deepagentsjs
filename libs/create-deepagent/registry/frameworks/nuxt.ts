import { createFramework } from "../../src/registry/framework.js";

export const nuxt = createFramework({
  id: "nuxt",
  title: "Nuxt",
  defaultProjectName: "nuxt-deepagents",
  address: {
    scheme: "github",
    owner: "aolsenjazz",
    repo: "deployment-cookbook",
    subPath: "js-nuxt",
  },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "server/agent",
  files: [],
});
