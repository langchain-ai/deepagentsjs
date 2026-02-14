/**
 * WASIX Daemon Process
 *
 * Boots the WASIX sandbox, exposes a Unix domain socket for shell attach,
 * and monitors for subagent spawn events.
 *
 * Usage: pnpm run demo:start
 */

import net from "node:net";
import fs from "node:fs";
import { WasixBackend } from "../src/index.js";
import {
  type BackendProtocol,
  type FileInfo,
  type FileData,
  type GrepMatch,
  type WriteResult,
  type EditResult,
  type FileDownloadResponse,
  type FileUploadResponse,
} from "deepagents";

const SOCKET_PATH = `/tmp/wasix-${process.pid}.sock`;
const WELL_KNOWN_SOCKET = `/tmp/wasix-session.sock`;

// --- Lifecycle logging ---

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

// --- Spawn event detection ---

let lineBuf = "";

function checkForSpawnEvents(text: string): void {
  lineBuf += text;
  const lines = lineBuf.split("\n");
  // Keep the last (possibly incomplete) line in the buffer
  lineBuf = lines.pop() ?? "";

  for (const line of lines) {
    const match = line.match(/Spawn request (\S+) submitted/);
    if (match) {
      const id = match[1];
      log(`┌─ [subagent] spawn request detected`);
      log(`│  id: ${id}`);
      log(`└─ (fire-and-forget)`);
    }
  }
}

// --- Stream pump ---

/**
 * Pump a Web ReadableStream to the daemon stdout and the attached client.
 * For the stdout stream, also watches for subagent spawn markers.
 */
async function pumpStream(
  stream: ReadableStream,
  label: string,
  getClient: () => net.Socket | null,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Write raw bytes to daemon stdout
      process.stdout.write(value);

      // Forward to attached client (if any)
      const client = getClient();
      if (client && !client.destroyed) {
        client.write(Buffer.from(value));
      }

      // Check for subagent spawn markers on stdout only
      if (label === "stdout") {
        const text = decoder.decode(value, { stream: true });
        checkForSpawnEvents(text);
      }
    }
  } catch (err) {
    // Stream closed or errored — expected during shutdown
    if (
      err instanceof Error &&
      !err.message.includes("released") &&
      !err.message.includes("cancel")
    ) {
      log(`[${label}] stream error: ${err}`);
    }
  }
}

// --- Cleanup ---

function cleanupFiles(): void {
  for (const p of [SOCKET_PATH, WELL_KNOWN_SOCKET]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // Already cleaned up or never created
    }
  }
}

// --- Generic Backend Implementations ---

class BaseDemoBackend implements BackendProtocol {
  isReadonly: boolean;

  files: Map<string, Uint8Array>;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = new Map();
    const encoder = new TextEncoder();
    for (const [path, value] of Object.entries(files)) {
      this.files.set(
        path,
        typeof value === "string" ? encoder.encode(value) : value,
      );
    }
  }

  async lsInfo(dir: string): Promise<FileInfo[]> {
    const norm = dir.endsWith("/") ? dir : dir + "/";
    const seen = new Set<string>();
    const results: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(norm)) {
        const rel = filePath.slice(norm.length);
        const parts = rel.split("/");
        if (parts.length > 1) {
          const subdir = norm + parts[0] + "/";
          if (!seen.has(subdir)) {
            results.push({ path: subdir, is_dir: true });
            seen.add(subdir);
          }
        } else if (parts[0]) {
          results.push({ path: norm + parts[0], is_dir: false });
        }
      }
    }
    return results;
  }

  async read(path: string, offset?: number, limit?: number): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    const text = new TextDecoder().decode(data);
    if (typeof offset === "number" || typeof limit === "number") {
      const lines = text.split("\n");
      const off = offset ?? 0;
      const lim = typeof limit === "number" ? limit : lines.length - off;
      return lines.slice(off, off + lim).join("\n");
    }
    return text;
  }

  async readRaw(path: string): Promise<FileData> {
    const data = this.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    const text = new TextDecoder().decode(data);
    const now = new Date().toISOString();
    return {
      content: text.split("\n"),
      created_at: now,
      modified_at: now,
    };
  }

  async grepRaw(
    pattern: string,
    dir?: string | null,
    glob?: string | null,
  ): Promise<GrepMatch[] | string> {
    const results: GrepMatch[] = [];
    for (const [filePath, data] of this.files.entries()) {
      if (dir && !filePath.startsWith(dir)) continue;
      if (glob && !filePath.match(globToRegExp(glob))) continue;
      const text = new TextDecoder().decode(data);
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(pattern)) {
          results.push({ path: filePath, line: idx + 1, text: line });
        }
      });
    }
    return results;
  }

  async globInfo(pattern: string, path?: string): Promise<FileInfo[]> {
    const regex = globToRegExp(pattern);
    const basePath = path ?? "/";
    const norm = basePath.endsWith("/") ? basePath : basePath + "/";
    const results: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      // Match against the path relative to the base
      const rel = filePath.startsWith(norm)
        ? filePath.slice(norm.length)
        : filePath.startsWith("/")
          ? filePath.slice(1)
          : filePath;
      if (regex.test(rel)) {
        results.push({ path: filePath, is_dir: false });
      }
    }
    return results;
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    if (this.files.has(filePath)) {
      return { error: `File already exists: ${filePath}` };
    }
    this.files.set(filePath, new TextEncoder().encode(content));
    return { path: filePath, filesUpdate: null };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const data = this.files.get(filePath);
    if (!data) return { error: `File not found: ${filePath}` };
    const text = new TextDecoder().decode(data);
    const count = text.split(oldString).length - 1;
    if (count === 0) return { error: `String not found in file '${filePath}'` };
    if (count > 1 && !replaceAll) {
      return { error: `Multiple occurrences found. Use replaceAll=true.` };
    }
    const newText = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    this.files.set(filePath, new TextEncoder().encode(newText));
    return { path: filePath, filesUpdate: null, occurrences: count };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    for (const [path, content] of files) {
      this.files.set(path, content);
    }
    return files.map(([path]) => ({ path, error: null }));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return paths.map((path) => {
      const data = this.files.get(path);
      if (!data)
        return {
          path,
          content: null,
          error: "file_not_found" as const,
        };
      return { path, content: new Uint8Array(data), error: null };
    });
  }
}

// Helper: very primitive glob-to-regexp (supports only "**" and "*" wildcards)
function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except for * and **
  let regex = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  regex = regex.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp("^" + regex + "$");
}

class FooBackend extends BaseDemoBackend {
  constructor() {
    super({
      "/a.txt": "i'm a text file, aaaaaaaa.",
      "/b.txt": "if you can read this, venmo me $10.",
      "/c.txt": "(now with 20% more bytes)",
    });
    this.isReadonly = true;
  }
}

class BarBackend extends BaseDemoBackend {
  constructor() {
    super({
      "/d.txt": "i'm a text file, bbbbbbbb.",
      "/e.txt": "the quick brown fox jumps over the lazy dog.",
      "/f.txt": "(now with 20% more bytes)",
    });
    this.isReadonly = false;
  }
}

// --- Main ---

async function main(): Promise<void> {
  log("Booting WASIX sandbox...");

  const backend = await WasixBackend.create({
    mounts: {
      "/foo": new FooBackend(),
      "/bar": new BarBackend(),
    },
  });
  const session = await backend.shell();

  log(`WASIX sandbox ready. Socket: ${SOCKET_PATH}`);

  // Clean up stale socket files from a previous crash
  cleanupFiles();

  // Create symlink at well-known path
  fs.symlinkSync(SOCKET_PATH, WELL_KNOWN_SOCKET);

  // Track the single attached client
  let attachedClient: net.Socket | null = null;

  function getAttachedClient(): net.Socket | null {
    return attachedClient;
  }

  // Create Unix domain socket server
  const server = net.createServer((socket) => {
    if (attachedClient !== null) {
      socket.write("ERROR: Another client is already attached.\n");
      socket.destroy();
      return;
    }

    attachedClient = socket;
    log("[attached] client connected");

    // Client → shell stdin
    socket.on("data", (chunk: Buffer) => {
      const writer = session.stdin.getWriter();
      writer.write(new Uint8Array(chunk)).then(
        () => writer.releaseLock(),
        () => writer.releaseLock(),
      );
    });

    socket.on("close", () => {
      attachedClient = null;
      log("[detached] client disconnected");
    });

    socket.on("error", () => {
      attachedClient = null;
      log("[detached] client disconnected (error)");
    });
  });

  // Register signal handlers before blocking on session.wait()
  const shutdown = () => {
    log("Shutting down...");
    session.kill();
    server.close();
    backend.close();
    cleanupFiles();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(SOCKET_PATH, () => {
    log(`Listening on ${SOCKET_PATH}`);
    log(`Symlinked to ${WELL_KNOWN_SOCKET}`);
    log("Waiting for attach...");
  });

  // Start pumping shell output (runs in background)
  pumpStream(session.stdout, "stdout", getAttachedClient);
  pumpStream(session.stderr, "stderr", getAttachedClient);

  // Block until the shell exits
  const { exitCode } = await session.wait();
  log(`Shell exited with code ${exitCode}`);

  server.close();
  backend.close();
  cleanupFiles();
  process.exit(exitCode);
}

// --- Entrypoint ---

main().catch((err) => {
  console.error("Fatal:", err);
  cleanupFiles();
  process.exit(1);
});
