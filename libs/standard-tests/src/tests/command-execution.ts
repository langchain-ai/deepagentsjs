import type { SandboxInstance, StandardTestsConfig } from "../types.js";

/**
 * Register command execution tests (echo, exit codes, multiline, stderr, env vars).
 */
export function registerCommandExecutionTests<T extends SandboxInstance>(
  getShared: () => T,
  config: StandardTestsConfig<T>,
  timeout: number,
): void {
  const { describe, it, expect } = config.runner;

  describe("command execution", () => {
    it(
      "should run a simple echo command",
      async () => {
        const result = await getShared().execute('echo "hello"');

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("hello");
        expect(result.truncated).toBe(false);
      },
      timeout,
    );

    it(
      "should capture non-zero exit code",
      async () => {
        const result = await getShared().execute("exit 42");

        expect(result.exitCode).toBe(42);
      },
      timeout,
    );

    it(
      "should capture multiline output",
      async () => {
        const result = await getShared().execute(
          'echo "line1" && echo "line2" && echo "line3"',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("line1");
        expect(result.output).toContain("line2");
        expect(result.output).toContain("line3");
      },
      timeout,
    );

    it(
      "should capture stderr output",
      async () => {
        const result = await getShared().execute('echo "error message" >&2');

        // stderr should be included in output
        expect(result.output).toContain("error message");
      },
      timeout,
    );

    it(
      "should handle command with environment variables",
      async () => {
        const result = await getShared().execute(
          'export MY_VAR="test_value" && echo $MY_VAR',
        );

        expect(result.exitCode).toBe(0);
        expect(result.output.trim()).toBe("test_value");
      },
      timeout,
    );

    it(
      "should handle non-existent command",
      async () => {
        const result = await getShared().execute("nonexistent_command_12345");

        expect(result.exitCode).not.toBe(0);
      },
      timeout,
    );
  });
}
