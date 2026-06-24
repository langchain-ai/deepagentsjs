import type { ProviderAwareFile } from "./provider.js";

/**
 * Create a ProviderAwareFile for `model.ts` that exports `coordinatorModel` and
 * `subagentModel`, instantiated from the selected provider's chat model class.
 *
 * @param agentPath - Path relative to project root, e.g. "lib/agent"
 */
export function createModelFile(agentPath: string): ProviderAwareFile {
  return {
    path: `${agentPath}/model.ts`,
    getContent: ({ providerConfig }) => {
      const {
        chatModelClass,
        dependency,
        defaultModel,
        coordinatorModelConfig,
      } = providerConfig;
      const pkg = dependency;
      const extra = coordinatorModelConfig
        ? `,\n  ${coordinatorModelConfig}`
        : "";

      return `import { ${chatModelClass} } from "${pkg}";

const coordinatorModel = new ${chatModelClass}({
  model: "${defaultModel}"${extra}
});

const subagentModel = new ${chatModelClass}({ model: "${defaultModel}" });

export { coordinatorModel, subagentModel };
`;
    },
  };
}
