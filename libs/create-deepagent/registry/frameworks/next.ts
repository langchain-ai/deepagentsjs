import { createFramework } from "../../src/registry/framework.js";

export const next = createFramework({
  id: "next",
  title: "Next.js",
  defaultProjectName: "next-deepagents",
  address: {
    scheme: "github",
    owner: "aolsenjazz",
    repo: "deployment-cookbook",
    subPath: "js-next",
  },
  envFilePath: ".env.local",
  packageJsonPath: "package.json",
  agentPath: "lib/agent",
  files: [],
});
