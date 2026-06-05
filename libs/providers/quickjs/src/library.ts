import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * A reusable code module pre-loaded into the QuickJS interpreter.
 *
 * Libraries are always available for import by name — the developer
 * decides at config time that this code is part of the interpreter.
 * Each library bundles its own PTC tool requirements so consumers
 * don't need to know internal infrastructure dependencies.
 */
export interface InterpreterLibrary {
  /**
   * Module name used in import statements inside QuickJS (e.g. "swarm").
   */
  name: string;

  /**
   * Short description of what the library provides.
   */
  description: string;

  /**
   * PTC tools the library requires at runtime.
   *
   * Strings are resolved from the agent's tool set by name.
   * Tool instances are injected directly without agent registration.
   */
  ptcTools: (string | StructuredToolInterface)[];

  /**
   * JS source for the entrypoint module (bare import resolves here).
   */
  source: string;

  /**
   * Additional module files keyed by relative POSIX path.
   *
   * Enables multi-file libraries — QuickJS resolves
   * `import { x } from "<name>/table.js"` to `files.get("table.js")`.
   * Single-file libraries can omit this.
   */
  files?: Map<string, string>;

  /**
   * Usage instructions injected into the system prompt.
   *
   * Provides the agent with API documentation, examples, and
   * guidance for using the library.
   */
  instructions: string;
}
