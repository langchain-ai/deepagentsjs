import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { spinner } from "@clack/prompts";

import { preflightCreate } from "./preflightCreate.js";
import { runCreateConfig } from "./runCreateConfig.js";
import { frameworks, providers } from "../../registry/index.js";
import { handleError } from "../../utils/handleError.js";
import { logger } from "../../utils/logger.js";
import { writeFile, loadJsonSync } from "../../utils/fileUtils.js";
import { gitInit } from "../../utils/git.js";
import type { ProviderAwareFile } from "../../registry/provider.js";
import { packageJsonSchema } from "../../schema/packageJson.js";
import { transformPackageJson } from "./transformPackageJson.js";
import { installTemplate } from "./installTemplate.js";

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
      process.exit(1);
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
  const s = spinner();

  try {
    const { framework, provider, projectName } = options;
    
    // 1. Install the template project
    s.start(`Copying ${framework.title} template...`);
    await installTemplate(projectPath, framework);

    // 2. Write files
    const envFile = createEnvFile(framework.envFilePath, options);
    const allFiles = [...framework.files, envFile];
    for (const file of allFiles) {
      const content = file.getContent({ providerConfig: provider });
      await writeFile(path.join(projectPath, file.path), content);
    }

    // 3. Transform package.json
    const packageJsonpath = path.join(projectPath, framework.packageJsonPath);
    const packageJson = packageJsonSchema.parse(loadJsonSync(packageJsonpath));
    const providerDependencies = Object.values(providers).map(
      (p) => p.dependency,
    );

    const transformed = transformPackageJson(packageJson, {
      projectName,
      provider,
      providerDependencies,
    });
    fs.writeFileSync(
      packageJsonpath,
      JSON.stringify(transformed, null, 2) + "\n",
    );

    // 4. Git init
    gitInit(projectPath);

    s.stop();
    logger.break();
    logger.success(`${framework.title} project created at ${projectName}`);
    logger.break();

    // 5. Post-init. Frameworks provide instructions on next steps
    if (framework.postInit) {
      framework.postInit({ projectPath });
    }
  } finally {
    s.stop();
  }
}

/**
 * Create an env file with values the user fills in.
 */
function createEnvFile(
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
