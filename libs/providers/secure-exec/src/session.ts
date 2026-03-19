/**
 * SecureExecSession — sandboxed Node.js V8 REPL session.
 *
 * ## Architecture
 *
 * Each session owns a single `NodeRuntime` (created lazily on the first
 * `eval()` call). State is persisted via source-code accumulation: top-level
 * declaration statements from prior evals are prepended as a preamble before
 * every new snippet, so the isolate re-evaluates them.
 *
 * Sessions are keyed by an opaque `id` in a static map. `toJSON()` returns
 * `{ id }` so sessions can be stored in LangGraph state and restored via
 * `fromJSON()`.
 *
 * File writes inside the REPL are buffered in the VFS (`pendingWrites`) and
 * flushed to the backend via `flushWrites(backend)` after each eval.
 *
 * PTC (programmatic tool calling) is bridged via a lightweight HTTP server
 * bound to `127.0.0.1` on a random port. Sandboxed code reaches host tools
 * through `fetch` calls injected by the transform preamble.
 */

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  allowAllFs,
  allowAllNetwork,
} from "secure-exec";
import { createTypeScriptTools } from "@secure-exec/typescript";
import type { StdioEvent } from "secure-exec";
import type { AnyBackendProtocol, BackendProtocolV2 } from "deepagents";
import { adaptBackendProtocol } from "deepagents";

import type { ReplResult, SecureExecSessionOptions } from "./types.js";
import { BackendVirtualFileSystem } from "./vfs.js";
export type { PendingWrite } from "./vfs.js";
import { transformForEval } from "./transform.js";
import { toCamelCase } from "./utils.js";

export const DEFAULT_MEMORY_LIMIT_MB = 64;
export const DEFAULT_CPU_TIME_LIMIT_MS = 30_000;
export const DEFAULT_SESSION_ID = "__default__";

type TypeScriptTools = ReturnType<typeof createTypeScriptTools>;

/**
 * Sandboxed Node.js V8 REPL session backed by secure-exec.
 *
 * Serializable — holds only an `id` in `toJSON()`, safe for LangGraph state.
 * The NodeRuntime is lazily started on the first `.eval()` call.
 */
export class SecureExecSession {
  private static sessions = new Map<string, SecureExecSession>();

  readonly id: string;

  /** Accumulated top-level declaration snippets for source-code state persistence. */
  private snippets: string[] = [];

  /** Mutable log buffer cleared before each eval. */
  private logs: string[] = [];

  private runtime: NodeRuntime | null = null;
  private tsTools: TypeScriptTools | null = null;
  private vfs: BackendVirtualFileSystem;
  private _backend: BackendProtocolV2 | null = null;
  private _options: SecureExecSessionOptions;

  /** HTTP bridge for PTC tool calling. */
  private ptcBridgeUrl: string | undefined;
  private ptcServer: Server | null = null;

  constructor(id: string, options: SecureExecSessionOptions = {}) {
    this.id = id;
    this._options = options;
    this.vfs = new BackendVirtualFileSystem();
  }

  /**
   * Get or create a session for the given id.
   * If the session exists, updates the backend reference.
   */
  static getOrCreate(
    id: string,
    options: SecureExecSessionOptions = {},
  ): SecureExecSession {
    const existing = SecureExecSession.sessions.get(id);
    if (existing) {
      if (options.backend) {
        const adapted = adaptBackendProtocol(options.backend);
        existing._backend = adapted;
        existing.vfs.setBackend(adapted);
      }
      return existing;
    }
    const session = new SecureExecSession(id, options);
    SecureExecSession.sessions.set(id, session);
    return session;
  }

  /** Retrieve an existing session by id, or null if none exists. */
  static get(id: string): SecureExecSession | null {
    return SecureExecSession.sessions.get(id) ?? null;
  }

  /** Clear the static session cache. Disposes all sessions. */
  static clearCache(): void {
    for (const session of SecureExecSession.sessions.values()) {
      session.dispose();
    }
    SecureExecSession.sessions.clear();
  }

  /** Start a local HTTP bridge for PTC tool invocations. */
  private async startPtcBridge(): Promise<void> {
    const tools = this._options.tools ?? [];
    if (tools.length === 0) return;

    const toolMap = new Map(tools.map((t) => [toCamelCase(t.name), t]));

    return new Promise<void>((resolve, reject) => {
      const server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on("end", () => {
            void (async () => {
              try {
                const { tool: toolName, input } = JSON.parse(body) as {
                  tool: string;
                  input: unknown;
                };
                const t = toolMap.get(toolName);
                if (!t) {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(
                    JSON.stringify({ error: `Tool '${toolName}' not found` }),
                  );
                  return;
                }
                const rawInput =
                  typeof input === "object" && input !== null ? input : {};
                const result = await t.invoke(
                  rawInput as Record<string, unknown>,
                );
                const resultStr =
                  typeof result === "string" ? result : JSON.stringify(result);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ result: resultStr }));
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: msg }));
              }
            })();
          });
        },
      );

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        this.ptcBridgeUrl = `http://127.0.0.1:${addr.port}`;
        this.ptcServer = server;
        resolve();
      });
      server.on("error", reject);
    });
  }

  /** Lazily initialize the NodeRuntime and TypeScriptTools. */
  private async ensureStarted(cpuTimeLimitMs: number): Promise<void> {
    if (this.runtime) return;

    const {
      memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB,
      backend,
      tools = [],
      allowNetwork = false,
    } = this._options;

    if (backend) {
      this._backend = adaptBackendProtocol(backend);
      this.vfs.setBackend(this._backend);
    }

    if (tools.length > 0) {
      await this.startPtcBridge();
    }

    const logs = this.logs;
    const onStdio = (event: StdioEvent) => {
      if (event.channel === "stderr") {
        logs.push(`[stderr] ${event.message}`);
      } else {
        logs.push(event.message);
      }
    };

    const needsNetwork = tools.length > 0 || allowNetwork;
    const permissions = {
      ...allowAllFs,
      ...(needsNetwork ? allowAllNetwork : {}),
    };

    const systemDriver = createNodeDriver({
      filesystem: this.vfs,
      ...(needsNetwork ? { useDefaultNetwork: true } : {}),
      permissions,
    });

    const runtimeDriverFactory = createNodeRuntimeDriverFactory();

    this.runtime = new NodeRuntime({
      systemDriver,
      runtimeDriverFactory,
      memoryLimit: memoryLimitMb,
      cpuTimeLimitMs,
      onStdio,
    });

    // Create TypeScript tools (per-session to avoid cross-session TS state).
    try {
      this.tsTools = createTypeScriptTools({
        systemDriver: createNodeDriver(),
        runtimeDriverFactory: createNodeRuntimeDriverFactory(),
        memoryLimit: memoryLimitMb,
      });
    } catch {
      this.tsTools = null;
    }
  }

  /**
   * Evaluate code in this session.
   *
   * On the first call, lazily starts the NodeRuntime. Code is transformed via
   * an AST pipeline that compiles TypeScript, classifies declarations for
   * accumulation, prepends previous snippets, and wraps in an async IIFE.
   */
  async eval(code: string, cpuTimeLimitMs: number): Promise<ReplResult> {
    await this.ensureStarted(cpuTimeLimitMs);

    this.logs.length = 0;

    const ptcToolNames = (this._options.tools ?? []).map((t) =>
      toCamelCase(t.name),
    );

    const { fullSource, result: transformResult } = await transformForEval(
      code,
      this.tsTools,
      [...this.snippets], // pass a copy so tests can inspect call args correctly
      this.ptcBridgeUrl,
      ptcToolNames,
    );

    const runResult = await this.runtime!.run<{ __result?: unknown }>(
      fullSource,
    );

    if (runResult.code !== 0) {
      return {
        ok: false,
        error: { message: runResult.errorMessage ?? "Execution failed" },
        logs: [...this.logs],
      };
    }

    this.snippets.push(...transformResult.declarationSnippets);

    return {
      ok: true,
      value: runResult.exports?.__result,
      logs: [...this.logs],
    };
  }

  /**
   * Flush buffered VFS writes to the backend.
   * Called by the middleware after eval completes.
   */
  async flushWrites(backend: AnyBackendProtocol): Promise<void> {
    const adapted = adaptBackendProtocol(backend);
    const writes = this.vfs.pendingWrites.splice(0);
    for (const { path, content } of writes) {
      await adapted.write(path, content);
    }
  }

  dispose(): void {
    try {
      this.runtime?.dispose();
    } catch {
      /* may already be disposed */
    }
    this.runtime = null;
    this.ptcServer?.close();
    this.ptcServer = null;
    SecureExecSession.sessions.delete(this.id);
  }

  toJSON(): { id: string } {
    return { id: this.id };
  }

  static fromJSON(data: { id: string }): SecureExecSession {
    return (
      SecureExecSession.sessions.get(data.id) ?? new SecureExecSession(data.id)
    );
  }
}
