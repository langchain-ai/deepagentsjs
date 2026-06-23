import * as clack from "@clack/prompts";
import {
  frameworks,
  type FrameworkKey,
  type ProviderKey,
  providers,
  ProviderConfig,
  FrameworkConfig,
} from "../../registry/index.js";

const PROCESSS_EXIT_MESSAGE = "Cancelled, exiting...";

/**
 * Guides the user through the config TUI. On SIGINT, either moves to the next
 * step or kills the process via `process.kill(0)`
 */
export async function runCreateConfig() {
  clack.intro("create-deepagent");

  const frameworkConfig = await selectFramework();
  const providerConfig = await selectProvider();
  const envVars = await collectEnvVars(providerConfig, frameworkConfig);
  const tracing = (await selectTracing()) ?? false;
  const langSmithKey = await collectLangSmithKey(tracing, frameworkConfig);

  return {
    frameworkChoice: frameworkConfig.id,
    providerChoice: providerConfig.id,
    envVars,
    tracing,
    langSmithKey,
  };
}

/** Prompt a user to select their framework */
async function selectFramework() {
  const frameworkOptions = Object.values(frameworks).map((f) => ({
    value: f.id,
    label: f.title,
  }));

  const frameworkChoice = await clack.select({
    message: "Select your framework",
    options: frameworkOptions,
  });

  if (clack.isCancel(frameworkChoice)) {
    clack.cancel(PROCESSS_EXIT_MESSAGE);
    process.exit(0);
  }

  const framework = frameworks[frameworkChoice as FrameworkKey];
  if (!framework) {
    throw new Error(`Framework "${frameworkChoice}" not found`);
  }

  return framework;
}

/** Prompt a user to select their provider */
async function selectProvider() {
  const providerOptions = Object.values(providers).map((p) => ({
    value: p.id,
    label: p.title,
  }));

  const providerChoice = (await clack.select({
    message: "Select your provider",
    options: providerOptions,
  })) as string;

  if (clack.isCancel(providerChoice)) {
    clack.cancel(PROCESSS_EXIT_MESSAGE);
    process.exit(0);
  }

  const provider = providers[providerChoice as ProviderKey];
  if (!provider) {
    throw new Error(`Provider "${providerChoice}" not found`);
  }

  return provider;
}

/** Prompt the user to enter env vars as are required by the provider spec */
async function collectEnvVars(
  provider: ProviderConfig,
  framework: FrameworkConfig,
) {
  const envVars: Record<string, string> = {};
  for (const spec of provider.env) {
    const optionalExitMessage = `Skipping ${spec.prompt}. You can add this later in ${framework.envFilePath}`;

    if (!spec.required) {
      const proceed = (await clack.select({
        message: `Enter your ${spec.prompt ?? spec.name}?`,
        initialValue: false,
        options: [
          { value: false, label: "Skip for now" },
          { value: true, label: "Yes" },
        ],
      })) as boolean;

      if (clack.isCancel(proceed)) {
        clack.cancel(optionalExitMessage);
        return;
      }

      if (!proceed) continue;
    }

    const val = (await clack.password({
      message: spec.prompt ?? spec.name,
      mask: "*",
    })) as string;

    if (clack.isCancel(val)) {
      if (spec.required) {
        clack.cancel(PROCESSS_EXIT_MESSAGE);
        process.exit(0);
      }

      clack.cancel(optionalExitMessage);
      return;
    }

    if (val && val.trim()) {
      envVars[spec.name] = val;
    }
  }
  return envVars;
}

/** Prompt a user to enable tracing */
async function selectTracing() {
  const tracing = (await clack.confirm({
    message: "Add LangSmith tracing?",
    initialValue: false,
  })) as boolean;

  if (clack.isCancel(tracing)) {
    clack.cancel("Skipping LangSmith tracing");
    return;
  }

  return tracing;
}

/** Prompt a user for their LangSmith API if tracing is enabled */
async function collectLangSmithKey(
  tracing: boolean,
  framework: FrameworkConfig,
) {
  if (!tracing) return;

  const exitMessage = `Skipping LangSmith API key. You can add this later in ${framework.envFilePath}`;

  const proceed = await clack.select({
    message: `Enter your LangSmith API key now?`,
    initialValue: false,
    options: [
      { value: false, label: "Skip for now" },
      { value: true, label: "Yes" },
    ],
  });

  if (clack.isCancel(proceed) || proceed === false) {
    clack.cancel(exitMessage);
    return;
  }

  const langSmithKey = (await clack.password({
    message: "Enter your LangSmith API key",
    mask: "*",
  })) as string;

  if (clack.isCancel(langSmithKey)) {
    clack.cancel(exitMessage);
    return;
  }

  return langSmithKey.trim() ? langSmithKey.trim() : undefined;
}
