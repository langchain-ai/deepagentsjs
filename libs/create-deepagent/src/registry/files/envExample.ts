import type { ProviderAwareFile } from "../provider.js";

/**
 * Create a ProviderAwareFile for `.env.example` with the provider's env var
 * names and commented-out LangSmith tracing lines.
 */
export function createEnvExampleFile(): ProviderAwareFile {
  return {
    path: ".env.example",
    getContent: ({ providerConfig }) => {
      const { env } = providerConfig;

      const lines: string[] = [];

      for (const spec of env) {
        const label = spec.prompt ?? spec.name;
        lines.push(`# Required: ${label} used by the agent and its subagents.`);
        lines.push(`${spec.name}=`);
      }

      lines.push("");
      lines.push("# Optional: enable LangSmith tracing.");
      lines.push("# LANGSMITH_TRACING=true");
      lines.push("# LANGSMITH_API_KEY=lsv2-...");

      return lines.join("\n") + "\n";
    },
  };
}
