import { Command } from "commander";
import path from "node:path";
import { z } from "zod";
import { spinner } from "@clack/prompts";

import { preflightCreate } from "./preflightCreate.js";
import { runCreateConfig } from "./runCreateConfig.js";
import {
  frameworks,
  type ProviderAwareFile,
  providers,
} from "../../registry/index.js";
import { handleError } from "../../utils/handleError.js";
import { copyDir, writeFile, resolveTemplateDir } from "../../utils/fs.js";

const cliOptionsSchema = z.object({
  name: z.string().optional(),
  force: z.boolean().optional(),
});
type CLIOptions = z.infer<typeof cliOptionsSchema>;
type TUIOptions = Awaited<ReturnType<typeof runCreateConfig>>;

export const create = new Command()
  .name("create")
  .description("Initialize your project and install dependencies")
  .option("-f, --force", "Force overwrite of existing files")
  .option("-n, --name <name>", "The name for the new project")
  .action(async (opts) => {
    try {
      const cliOptions = cliOptionsSchema.parse(opts);
      const tuiOptions = await runCreateConfig();
      const options = mergeOptions(cliOptions, tuiOptions);

      const projectPath = await preflightCreate(options);
      await runCreate(projectPath, options);
    } catch (e) {
      handleError(e);
    }
  });

/**
 * Merges CLI and TUI options. While CLI options are limited, this function will be
 * pretty slim.
 */
function mergeOptions(cliOptions: CLIOptions, tuiOptions: TUIOptions) {
  const { name, force } = cliOptions;
  const { frameworkChoice, envVars, langSmithKey, providerChoice, tracing } =
    tuiOptions;

  const framework = frameworks[frameworkChoice];
  const provider = providers[providerChoice];

  return {
    framework,
    provider,
    projectName: name || framework.defaultProjectName,
    force,
    tracing,
    langSmithKey,
    envVars,
  };
}

type RunCreateOptions = ReturnType<typeof mergeOptions>;

async function runCreate(projectPath: string, options: RunCreateOptions) {
  const { framework, provider } = options;
  const s = spinner();

  // 1. Copy the template project
  const templateDir = resolveTemplateDir(framework.frameworkDir);
  s.start(`Copying ${framework.title} template...`);
  await copyDir(templateDir, projectPath);

  // 2. Write files
  const envFile = createEnvFile(framework.envFilePath, options);
  const allFiles = [...framework.files, envFile];
  for (const file of allFiles) {
    const content = file.getContent({ providerConfig: provider });
    await writeFile(path.join(projectPath, file.path), content);
  }

  s.stop();
}

/**
 * Create an env file with values the user fills in.
 */
export function createEnvFile(
  envFilePath: string,
  opts: {
    envVars?: Record<string, string>;
    tracing: boolean;
    langSmithKey?: string;
  },
): ProviderAwareFile {
  const envVars = opts.envVars || {};

  return {
    path: envFilePath,
    getContent: () => {
      const lines: string[] = [];

      for (const [key, value] of Object.entries(envVars)) {
        lines.push(`${key}=${value}`);
      }

      if (opts.tracing) {
        lines.push("LANGSMITH_TRACING=true");
        if (opts.langSmithKey) {
          lines.push(`LANGSMITH_API_KEY=${opts.langSmithKey}`);
        }
      }

      return lines.join("\n") + "\n";
    },
  };
}
