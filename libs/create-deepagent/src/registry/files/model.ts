import type { ProviderAwareFile } from "../provider.js";

/**
 * Create a ProviderAwareFile for `model.ts` that exports `coordinatorModel` and
 * `subagentModel`, instantiated via `initChatModel` with the selected provider.
 *
 * @param agentPath - Path relative to project root, e.g. "lib/agent"
 */
export function createModelFile(agentPath: string): ProviderAwareFile {
  return {
    path: `${agentPath}/model.ts`,
    getContent: ({ providerConfig }) => {
      const { defaultModel, coordinatorModelConfig } = providerConfig;

      const lines: string[] = [
        'import { initChatModel } from "langchain/chat_models/universal";',
        "",
        `const coordinatorModel = await initChatModel("${defaultModel}"${
          coordinatorModelConfig ? `, { ${coordinatorModelConfig} }` : ""
        });`,
        "",
        `const subagentModel = await initChatModel("${defaultModel}");`,
        "",
        "export { coordinatorModel, subagentModel };",
      ];

      return lines.join("\n") + "\n";
    },
  };
}
