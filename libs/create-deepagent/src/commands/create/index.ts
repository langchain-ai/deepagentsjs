import { Command } from "commander";
import { preflightCreate } from "./preflightCreate.js";
import { z } from "zod";
import { runCreateConfig } from "./runCreateConfig.js";
import { frameworks, providers } from "../../registry/index.js";
import { handleError } from "../../utils/handleError.js";
import { logger } from "../../utils/logger.js";

const cliOptionsSchema = z.object({
  cwd: z.string().optional(),
  name: z.string().optional(),
  force: z.boolean().optional(),
});
type CLIOptions = z.infer<typeof cliOptionsSchema>;
type TUIOptions = Awaited<ReturnType<typeof runCreateConfig>>;

export const create = new Command()
  .name("create")
  .description("Initialize your project and install dependencies")
  .option(
    "-c, --cwd <cwd>",
    "The working directory. Defaults to the current directory.",
    process.cwd(),
  )
  .option("-f, --force", "Force overwrite of existing files")
  .option("-n, --name <name>", "The name for the new project")
  .action(async (opts) => {
    try {
      const cliOptions = cliOptionsSchema.parse(opts);
      const tuiOptions = await runCreateConfig();
      const options = mergeOptions(cliOptions, tuiOptions);

      await preflightCreate();
      await runCreate(options);
    } catch (e) {
      handleError(e);
    }
  });

/**
 * Merges CLI and TUI options. While CLI options are limited, this function will be
 * pretty slim.
 */
function mergeOptions(cliOptions: CLIOptions, tuiOptions: TUIOptions) {
  const { cwd, force, name } = cliOptions;
  const { frameworkChoice, envVars, langSmithKey, providerChoice, tracing } =
    tuiOptions;

  const framework = frameworks[frameworkChoice];
  const provider = providers[providerChoice];

  return {
    framework,
    provider,
    projectName: name || framework.defaultProjectName,
    cwd,
    force,
    tracing,
    langSmithKey,
    envVars,
  };
}

type RunCreateOptions = ReturnType<typeof mergeOptions>;
async function runCreate(options: RunCreateOptions) {
  // no-op for now
  logger.info(JSON.stringify(options));
}
