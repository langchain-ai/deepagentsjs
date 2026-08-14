/**
 * ACP Filesystem Backend
 *
 * Proxies file read/write operations through the ACP client connection,
 * enabling access to unsaved editor buffers and IDE-tracked modifications.
 * Falls back to local filesystem for operations ACP doesn't support.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import {
  FilesystemBackend,
  type WriteResult,
  type ReadResult,
} from "deepagents";

/**
 * Backend that proxies read/write through ACP client while using local
 * filesystem for ls, glob, grep operations.
 */
export class ACPFilesystemBackend extends FilesystemBackend {
  private conn: AgentSideConnection;
  private currentSessionId: string | null = null;

  constructor(options: { conn: AgentSideConnection; rootDir: string }) {
    // virtualMode confines all path resolution to rootDir: tool paths are
    // treated as virtual paths under the workspace and traversal (.., ~) is
    // blocked, so searches can never escape to the host filesystem. This
    // matches the Python deepagents-acp server, which constructs its backend
    // as FilesystemBackend(root_dir=cwd, virtual_mode=True).
    super({ rootDir: options.rootDir, virtualMode: true });
    this.conn = options.conn;
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  // Map an incoming (virtual) tool path to the real absolute path the ACP
  // client expects, reusing the backend's virtual-aware resolution.
  private resolveAbsPath(filePath: string): string {
    return this.resolvePath(filePath);
  }

  /**
   * Read file via ACP client (gets unsaved editor buffers).
   * Falls back to local filesystem if ACP read fails.
   */
  async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
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

      return { content: text };
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
