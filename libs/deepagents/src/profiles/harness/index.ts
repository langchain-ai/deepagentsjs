export {
  // Interfaces
  type GeneralPurposeSubagentConfig,
  type HarnessProfile,
  type HarnessProfileOptions,
  type HarnessProfileConfigData,
  // Factory and serialization
  createHarnessProfile,
  serializeProfile,
  parseHarnessProfileConfig,
  // Zod schemas (for advanced users who need custom validation pipelines)
  harnessProfileConfigSchema,
  generalPurposeSubagentConfigSchema,
  // Constants
  EMPTY_HARNESS_PROFILE,
  REQUIRED_MIDDLEWARE_NAMES,
  // Internal helpers re-exported for registry module
  resolveMiddleware,
} from "./types.js";
