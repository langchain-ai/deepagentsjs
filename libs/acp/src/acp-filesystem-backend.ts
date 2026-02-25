/**
 * ACP Filesystem Backend
 *
 * Proxies file read/write operations through the ACP client connection,
 * enabling access to unsaved editor buffers and IDE-tracked modifications.
 * Falls back to local filesystem for operations ACP doesn't support.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { FilesystemBackend, type WriteResult } from "deepagents";
import path from "node:path";

/**
 * Backend that proxies read/write through ACP client while using local
 * filesystem for ls, glob, grep operations.
 */
export class ACPFilesystemBackend extends FilesystemBackend {
  private conn: AgentSideConnection;
  private currentSessionId: string | null = null;

  constructor(options: {
    conn: AgentSideConnection;
    rootDir: string;
  }) {
    super({ rootDir: options.rootDir });
    this.conn = options.conn;
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  private resolveAbsPath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(this.cwd, filePath);
  }

  /**
   * Read file via ACP client (gets unsaved editor buffers).
   * Falls back to local filesystem if ACP read fails.
   */
  async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<string> {
    if (!this.currentSessionId) {
      return super.read(filePath, offset, limit);
    }

    const absPath = this.resolveAbsPath(filePath);
    try {
      const result = await this.conn.readTextFile({
        sessionId: this.currentSessionId,
        path: absPath,
      } as any);

      let text = (result as any).content ?? (result as any).text ?? "";

      if (offset != null || limit != null) {
        const lines = text.split("\n");
        const start = offset ?? 0;
        const end = limit != null ? start + limit : lines.length;
        text = lines.slice(start, end).join("\n");
      }

      return text;
    } catch {
      return super.read(filePath, offset, limit);
    }
  }

  /**
   * Write file via ACP client (IDE tracks modifications).
   * Falls back to local filesystem if ACP write fails.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    if (!this.currentSessionId) {
      return super.write(filePath, content);
    }

    const absPath = this.resolveAbsPath(filePath);
    try {
      await this.conn.writeTextFile({
        sessionId: this.currentSessionId,
        path: absPath,
        content,
      } as any);
      return { path: absPath, filesUpdate: null };
    } catch {
      return super.write(filePath, content);
    }
  }
}
