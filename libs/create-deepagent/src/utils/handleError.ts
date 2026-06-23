import { logger } from "./logger.js";

export function handleError(e: unknown) {
  logger.break();
  logger.error(
    `Something went wrong. Please check the error below for more details.`,
  );
  logger.error(`If the problem persists, please open an issue on GitHub.`);
  logger.break();

  if (e && typeof e === "object" && "name" in e && e.name === "ZodError") {
    // Handle Zod errors
    const { flatten } = e as unknown as {
      flatten: () => { fieldErrors: Record<string, string[]> };
    };
    for (const [key, value] of Object.entries(flatten().fieldErrors)) {
      logger.error(`- ${key}: ${value}`);
    }
  } else if (
    e &&
    typeof e === "object" &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
  ) {
    // Handle `Error` types
    logger.error((e as { message: string }).message);
  }
}
