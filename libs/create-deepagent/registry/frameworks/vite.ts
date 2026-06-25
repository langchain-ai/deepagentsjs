import { createFramework } from "../../src/registry/framework.js";

export const vite = createFramework({
  id: "react-vite",
  title: "React + Vite",
  defaultProjectName: "react-deepagents",
  address: {
    scheme: "github",
    owner: "aolsenjazz",
    repo: "deployment-cookbook",
    subPath: "js-langsmith",
  },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "agent",
  files: [],
});
