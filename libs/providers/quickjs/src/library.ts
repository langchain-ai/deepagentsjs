import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "yaml";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { stripTypeSyntax } from "./transform.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;
const LIBRARY_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIBRARY_MD = "LIBRARY.md";

/**
 * File extensions the loader will look for as library entrypoints,
 * checked in priority order.
 */
const ENTRY_EXTENSIONS = ["index.js", "index.ts", "index.mjs", "index.mts"];

/**
 * Hard cap on library source size (1 MiB), matching skill bundles.
 */
const MAX_LIBRARY_SOURCE_BYTES = 1 * 1024 * 1024;

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
   * Documentation content for progressive disclosure.
   *
   * Rendered from the LIBRARY.md body (everything after frontmatter).
   * The agent can read this via `tools.readFile` at
   * `/libraries/<name>/LIBRARY.md`.
   */
  docs: string;
}

/**
 * Parsed frontmatter fields from a LIBRARY.md file.
 */
interface LibraryFrontmatter {
  /**
   * Kebab-case library name from the `name` frontmatter field.
   */
  name: string;

  /**
   * Short description from the `description` frontmatter field.
   */
  description: string;

  /**
   * PTC tool names from the `ptcTools` frontmatter field.
   */
  ptcTools: string[];

  /**
   * Markdown body after the closing `---` delimiter.
   */
  docs: string;
}

/**
 * Find and read the library entrypoint, stripping TypeScript syntax.
 *
 * Checks `index.{js,ts,mjs,mts}` in priority order. Validates the
 * source size against `MAX_LIBRARY_SOURCE_BYTES`.
 */
async function resolveEntrypoint(
  dirPath: string,
  libraryName: string,
): Promise<string> {
  for (const filename of ENTRY_EXTENSIONS) {
    const fullPath = path.join(dirPath, filename);
    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      if (raw.length > MAX_LIBRARY_SOURCE_BYTES) {
        throw new Error(
          `Library '${libraryName}': source exceeds ` +
            `${MAX_LIBRARY_SOURCE_BYTES} bytes (${raw.length})`,
        );
      }
      return stripTypeSyntax(raw);
    } catch (err) {
      if (
        err != null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Library '${libraryName}': no entrypoint found in '${dirPath}'. ` +
      `Expected one of: ${ENTRY_EXTENSIONS.join(", ")}`,
  );
}

/**
 * Parse LIBRARY.md content into structured frontmatter fields.
 *
 * Extracts YAML frontmatter between `---` delimiters and validates
 * required fields (name, description). The markdown body after the
 * closing delimiter becomes the `docs` field.
 */
export function parseFrontmatter(
  content: string,
  filePath: string,
): LibraryFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`${filePath}: no valid YAML frontmatter found`);
  }

  const data = yaml.parse(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${filePath}: frontmatter is not a YAML mapping`);
  }

  const name = String(data.name ?? "").trim();
  if (!name) {
    throw new Error(`${filePath}: missing required 'name' field`);
  }
  if (!LIBRARY_NAME_RE.test(name)) {
    throw new Error(
      `${filePath}: name '${name}' must be lowercase kebab-case ` +
        `(matching ${LIBRARY_NAME_RE})`,
    );
  }

  const description = String(data.description ?? "").trim();
  if (!description) {
    throw new Error(`${filePath}: missing required 'description' field`);
  }

  const rawTools = data.ptcTools;
  let ptcTools: string[] = [];
  if (Array.isArray(rawTools)) {
    ptcTools = rawTools.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof rawTools === "string") {
    ptcTools = rawTools.split(/\s+/).filter(Boolean);
  }

  const docs = (match[2] ?? "").trim();

  return { name, description, ptcTools, docs };
}

/**
 * Load a user-authored library from a directory on disk.
 *
 * The directory must contain a `LIBRARY.md` with YAML frontmatter
 * (name, description, ptcTools) and a JS/TS entrypoint. The
 * entrypoint is auto-detected from `index.{js,ts,mjs,mts}`.
 *
 * Returns a fully resolved `InterpreterLibrary` ready to pass into
 * `CodeInterpreterMiddleware({ libraries: [...] })`.
 *
 * @param dirPath - Absolute path to the library directory.
 * @returns A resolved `InterpreterLibrary`.
 */
export async function loadLibrary(
  dirPath: string,
): Promise<InterpreterLibrary> {
  const mdPath = path.join(dirPath, LIBRARY_MD);

  let mdContent: string;
  try {
    mdContent = await fs.readFile(mdPath, "utf-8");
  } catch {
    throw new Error(`Library at '${dirPath}': missing ${LIBRARY_MD}`);
  }

  const frontmatter = parseFrontmatter(mdContent, mdPath);

  const source = await resolveEntrypoint(dirPath, frontmatter.name);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    ptcTools: frontmatter.ptcTools,
    source,
    docs: frontmatter.docs,
  };
}
