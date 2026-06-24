import type { ProviderConfig } from "./provider.js";
import { createModelFile } from "./model.js";
import { createEnvExampleFile } from "./env.js";

export interface ProviderAwareFile {
  /** Path relative to project root, e.g. "worker/env.d.ts" */
  path: string;
  /** Returns the file content, optionally using provider config for string injection */
  getContent: (config: { providerConfig: ProviderConfig }) => string;
}

export interface FrameworkConfig<T extends string = string> {
  /** Unique identifier. Probably the same as frameworkDir */
  id: T;
  /** Shown in the "Select your framework" prompt */
  title: string;
  /** e.g. "next-deepagents" */
  defaultProjectName: string;
  /** Template dir name, e.g. "next-js" */
  frameworkDir: string;
  /** Path to the env file, relative to project root */
  envFilePath: string;
  /** Path to package.json, relative to project root */
  packageJsonPath: string;
  /** Where agent-related files are written, relative to project root */
  agentPath: string;
  /** Context-dependent files to be written (e.g. env.d.ts) */
  files: ProviderAwareFile[];
  /** Post-init instructions, if necessary */
  postInit?: (opts: { projectPath: string }) => void;
}

export function createFramework<T extends string>(
  config: FrameworkConfig<T>,
): FrameworkConfig<T> {
  const defaultFiles = [
    createModelFile(config.agentPath),
    createEnvExampleFile(),
  ];

  return {
    ...config,
    files: [...config.files, ...defaultFiles],
  };
}
