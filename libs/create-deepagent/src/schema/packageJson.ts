import { z } from "zod";

export const packageJsonSchema = z.looseObject({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()),
  packageManager: z.string().optional(),
});

export type PackageJson = z.infer<typeof packageJsonSchema>;
