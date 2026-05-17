/**
 * Python skills loader.
 *
 * Scans user code for `import skills.<name>` / `from skills.<name> import …`
 * references and stages each skill directory from a deepagents
 * `BackendProtocol` into the sandbox VFS under `/skills/<package_name>/`.
 * An `__init__.py` is synthesised if the skill author didn't ship one,
 * so plain `import skills.<name>` always works.
 *
 * Mirrors `langchain_wasmsh._skills` in the Python adapter; keep the two
 * implementations functionally aligned (skill name validation, package
 * name convention, extension list, bundle size cap).
 */
import type {
  BackendProtocolV2,
  FileDownloadResponse,
  MaybePromise,
} from "deepagents";
import type { WasmshSandbox } from "./sandbox.js";
import type { WasmshLogger } from "./types.js";

// Skill loading needs the V2 glob surface plus a required downloadFiles
// (V1's `downloadFiles?` is optional; we narrow to the concrete signature
// so call sites don't have to guard each invocation).
type SkillBackend = Pick<BackendProtocolV2, "glob"> & {
  downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
};

const MODULE_EXTENSIONS = [".py"] as const;
const DATA_EXTENSIONS = [
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".md",
] as const;
const MAX_BUNDLE_BYTES = 1 * 1024 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SKILL_IMPORT_RE =
  /^\s*(?:from\s+skills\.([a-z0-9_]+(?:\.[a-z0-9_]+)*)\s+import\b|import\s+skills\.([a-z0-9_]+(?:\.[a-z0-9_]+)*))/gm;

/**
 * Extract the set of skill package names a snippet of Python code
 * references via `import skills.<name>` or `from skills.<name> import …`.
 * Returns package names (snake form), matching how the user writes them
 * in code; convert back to kebab-case for metadata lookup.
 */
export function scanSkillReferences(source: string): Set<string> {
  const seen = new Set<string>();
  SKILL_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_IMPORT_RE.exec(source)) !== null) {
    const name = match[1] ?? match[2] ?? "";
    const head = name.split(".", 1)[0];
    if (head) seen.add(head);
  }
  return seen;
}

export interface SkillMetadata {
  name: string;
  path: string;
  description: string;
  module?: string | null;
}

function packageName(skillName: string): string {
  return skillName.replace(/-/g, "_");
}

function skillDir(metadata: SkillMetadata): string {
  const idx = metadata.path.lastIndexOf("/");
  return idx < 0 ? "." : metadata.path.slice(0, idx) || "/";
}

function relative(skillDirAbs: string, absolutePath: string): string {
  const prefix = skillDirAbs.endsWith("/") ? skillDirAbs : `${skillDirAbs}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(
      `file ${absolutePath!} is not under skill dir ${skillDirAbs}`,
    );
  }
  return absolutePath.slice(prefix.length);
}

interface LoadedSkill {
  name: string;
  packageName: string;
  files: Map<string, Uint8Array>;
}

async function enumerateSkillFiles(
  backend: SkillBackend,
  skillDirAbs: string,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const ext of [...MODULE_EXTENSIONS, ...DATA_EXTENSIONS]) {
    const result = await backend.glob(`**/*${ext}`, skillDirAbs);
    if (result.error) {
      throw new Error(
        `failed to list skill dir ${skillDirAbs}: ${result.error}`,
      );
    }
    for (const entry of result.files ?? []) {
      seen.add(entry.path);
    }
  }
  return [...seen].sort();
}

function asBytes(content: unknown): Uint8Array {
  // The backend protocol guarantees `string | Uint8Array`, but a wrong-
  // shape return from a misbehaving backend would silently propagate
  // garbage downstream — `byteLength` would be `undefined`, poisoning
  // the bundle-size cap and surfacing as cryptic `TypeError` at upload
  // time. Validate explicitly.
  if (typeof content === "string") return new TextEncoder().encode(content);
  // Structural check matching the codebase's `no-instanceof` lint rule.
  if (
    content !== null &&
    typeof content === "object" &&
    typeof (content as { byteLength?: unknown }).byteLength === "number" &&
    ArrayBuffer.isView(content as ArrayBufferView)
  ) {
    const view = content as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error(
    `skill file returned non-binary content of type ${typeof content}`,
  );
}

export async function loadSkill(
  metadata: SkillMetadata,
  backend: SkillBackend,
): Promise<LoadedSkill> {
  if (!SKILL_NAME_RE.test(metadata.name)) {
    throw new Error(
      `skill name ${JSON.stringify(metadata.name)} is not a valid kebab-case identifier`,
    );
  }
  const dir = skillDir(metadata);
  const filePaths = await enumerateSkillFiles(backend, dir);
  if (filePaths.length === 0) {
    throw new Error(
      `skill ${JSON.stringify(metadata.name)}: no Python files under ${dir}`,
    );
  }
  const downloads = await backend.downloadFiles(filePaths);
  const filePairs: Array<[string, Uint8Array]> = [];
  for (const resp of downloads) {
    if (resp.error || resp.content == null) {
      throw new Error(
        `skill ${JSON.stringify(metadata.name)}: failed to download ${resp.path}: ${resp.error}`,
      );
    }
    filePairs.push([resp.path, asBytes(resp.content)]);
  }
  const pkg = packageName(metadata.name);
  const entryRel = metadata.module ?? null;
  let hasInit = false;
  let entryFound = entryRel == null;
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const [absPath, content] of filePairs) {
    const rel = relative(dir, absPath);
    const target = `/skills/${pkg}/${rel}`;
    files.set(target, content);
    total += content.byteLength;
    if (rel === "__init__.py") hasInit = true;
    if (entryRel != null && rel === entryRel) entryFound = true;
  }
  if (entryRel != null && !entryFound) {
    throw new Error(
      `skill ${pkg}: module path ${entryRel} did not match any file in the skill directory`,
    );
  }
  if (!hasInit) {
    let synth = `"""Auto-generated skill package init."""\n`;
    if (entryRel != null && entryRel.endsWith(".py")) {
      const stem = entryRel.replace(/\.py$/, "").replace(/^.*\//, "");
      if (stem !== "__init__") {
        synth += `from .${stem} import *  # noqa: F401,F403\n`;
      }
    }
    const initBytes = new TextEncoder().encode(synth);
    files.set(`/skills/${pkg}/__init__.py`, initBytes);
    total += initBytes.byteLength;
  }
  if (total > MAX_BUNDLE_BYTES) {
    throw new Error(
      `skill ${pkg} bundle exceeds ${MAX_BUNDLE_BYTES} bytes (total ${total})`,
    );
  }
  return { name: metadata.name, packageName: pkg, files };
}

/**
 * Stage every skill referenced in `source` that hasn't already been
 * uploaded for this session. Mutates `installed` with the package names
 * that succeeded; per-skill failures are logged but don't abort the load.
 */
export async function installPendingSkills({
  source,
  metadata,
  backend,
  sandbox,
  installed,
  logger,
}: {
  source: string;
  metadata: Map<string, SkillMetadata>;
  backend: SkillBackend;
  sandbox: WasmshSandbox;
  installed: Set<string>;
  logger?: WasmshLogger;
}): Promise<void> {
  const referenced = scanSkillReferences(source);
  for (const pkg of referenced) {
    if (installed.has(pkg)) continue;
    const kebab = pkg.replace(/_/g, "-");
    const meta = metadata.get(kebab) ?? metadata.get(pkg);
    if (!meta) continue;
    try {
      const loaded = await loadSkill(meta, backend);
      await sandbox.uploadFiles([...loaded.files.entries()]);
      installed.add(loaded.packageName);
    } catch (err) {
      // Security-relevant errors must not be demoted to a log line: if a
      // skill metadata `path` contains `..` segments and the backend is a
      // namespaced `WasmshFilesystemBackend`, the resulting throw is the
      // namespace guard doing its job and must surface to the caller.
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { name?: unknown }).name === "WasmshNamespaceEscapeError"
      ) {
        throw err as Error;
      }
      // Best-effort for non-security failures: a single broken skill must
      // not abort the eval. The structured logger is the preferred surface;
      // when none is wired we fall back to stderr so the failure doesn't
      // disappear entirely.
      try {
        logger?.skillLoadError?.({ skill: meta.name, error: err });
      } catch {
        // Logger contract forbids throwing; swallow so the other skills
        // still get a chance to load.
      }
      if (!logger?.skillLoadError) {
        const message =
          typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        const line = `[wasmsh] failed to load skill ${JSON.stringify(meta.name)}: ${message}\n`;
        // Guard against environments without `process.stderr` (browser).
        if (
          typeof process !== "undefined" &&
          process.stderr &&
          typeof process.stderr.write === "function"
        ) {
          process.stderr.write(line);
        }
      }
    }
  }
}
