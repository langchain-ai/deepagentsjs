import { inspect } from "node:util";
import type { ProviderAwareFile } from "../provider.js";

/**
 * Create a ProviderAwareFile for `model.ts` that exports `coordinatorModel` and
 * `subagentModel`, instantiated via direct constructor imports with the selected
 * provider.
 *
 * @param agentPath - Path relative to project root, e.g. "lib/agent"
 */
export function createModelFile(agentPath: string): ProviderAwareFile {
  return {
    path: `${agentPath}/model.ts`,
    getContent: ({ providerConfig }) => {
      const {
        defaultModel,
        coordinatorModelConfig,
        dependency,
        chatModelClassName,
      } = providerConfig;

      const coordinatorOptions = {
        model: defaultModel,
        ...(coordinatorModelConfig ?? {}),
      };

      const lines: string[] = [
        `import { ${chatModelClassName} } from "${dependency}";`,
        "",
        `const coordinatorModel = new ${chatModelClassName}(${inspect(coordinatorOptions, { depth: null, compact: false })});`,
        "",
        `const subagentModel = new ${chatModelClassName}(${inspect({ model: defaultModel }, { depth: null, compact: false })});`,
        "",
        "export { coordinatorModel, subagentModel };",
      ];

      return lines.join("\n") + "\n";
    },
  };
}
