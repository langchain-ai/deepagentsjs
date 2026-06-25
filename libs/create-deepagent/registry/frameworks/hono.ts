import { createFramework } from "../../src/registry/framework.js";
import { resolveFrameworkDir } from "../../src/utils/fileUtils.js";
import type { ProviderAwareFile } from "../../src/registry/provider.js";

const ENV_D_TS: ProviderAwareFile = {
  path: "worker/env.d.ts",
  getContent: ({ providerConfig }) => {
    const envVars = providerConfig.env
      .map((e) => `  ${e.name}: string;`)
      .join("\n");

    return `interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
${envVars}
  [key: string]: string | undefined;
}
`;
  },
};

export const hono = createFramework({
  id: "hono",
  title: "Hono",
  defaultProjectName: "hono-deepagents",
  address: { scheme: "local", path: resolveFrameworkDir("hono") },
  envFilePath: ".env",
  packageJsonPath: "package.json",
  agentPath: "worker/agent",
  files: [ENV_D_TS],
});
