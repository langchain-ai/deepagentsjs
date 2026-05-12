import * as readline from "node:readline/promises";

/**
 * Prints an informational message to stdout.
 */
export function info(message: string): void {
  console.log(message);
}

/**
 * Prints a success message to stdout.
 */
export function success(message: string): void {
  console.log(`✔ ${message}`);
}

/**
 * Prints a warning message to stderr.
 */
export function warn(message: string): void {
  console.error(`⚠ ${message}`);
}

/**
 * Prints an error message to stderr and exits with code 1.
 */
export function fatal(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/**
 * Prompts the user for a yes/no confirmation via stdin.
 * Returns true if the user answers "y" or "yes" (case-insensitive).
 * Returns false for any other input or if stdin is not interactive.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
