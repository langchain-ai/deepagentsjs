import type { PackageJson } from "../../schema/packageJson.js";
import type { ProviderConfig } from "../../registry/provider.js";

export type TransformConfig = {
  projectName: string;
  provider: ProviderConfig;
  /** All provider dependencies to strip from the template */
  providerDependencies: string[];
};

/**
 * Pure transformation of a template's package.json for the scaffolded project.
 */
export function transformPackageJson(
  packageJson: PackageJson,
  config: TransformConfig,
): PackageJson {
  const result: PackageJson = {
    ...packageJson,
    dependencies: { ...packageJson.dependencies },
  };

  // 1. Set the project name
  result.name = config.projectName;

  // 2. Strip extant provider dependencies from the template
  for (const dep of Object.keys(result.dependencies)) {
    if (config.providerDependencies.includes(dep)) {
      delete result.dependencies[dep];
    }
  }

  // 3. Inject the selected provider's dependency
  result.dependencies = {
    ...result.dependencies,
    [config.provider.dependency]: "latest",
  };

  // 4. Remove the packageManager field if present
  delete result.packageManager;

  return result;
}
