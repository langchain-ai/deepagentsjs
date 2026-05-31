/**
 * Adapter to convert v1 SandboxInstance to v2 SandboxInstanceV2.
 */

import { adaptSandboxProtocol } from "deepagents";
import type { AnySandboxInstance, SandboxInstanceV2 } from "./types.js";

/**
 * Adapt a sandbox instance (v1 or v2) to SandboxInstanceV2.
 *
 * This builds on {@link adaptSandboxProtocol} from deepagents, which handles
 * the core protocol adaptation (BackendProtocol → BackendProtocolV2 and
 * sandbox properties execute/id).
 *
 * This function additionally preserves test-specific properties:
 * - `isRunning` (required)
 * - `close` (optional)
 * - `initialize` (optional)
 * - `uploadFiles` (required, though optional in base protocol)
 * - `downloadFiles` (required, though optional in base protocol)
 *
 * @param sandbox - Sandbox instance (v1 or v2)
 * @returns SandboxInstanceV2-compatible sandbox
 */
export function adaptSandboxInstance(
  sandbox: AnySandboxInstance,
): SandboxInstanceV2 {
  // First adapt the sandbox backend protocol (v1 → v2)
  const adapted = adaptSandboxProtocol(sandbox as any);

  const sb = sandbox as any;

  // Preserve close method if present
  if (typeof sb.close === "function") {
    (adapted as any).close = () => sb.close();
  }

  // Preserve isRunning (required for SandboxInstance)
  const isRunningDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(sandbox),
    "isRunning",
  );
  if (isRunningDescriptor?.get) {
    Object.defineProperty(adapted, "isRunning", {
      get: () => sb.isRunning,
      enumerable: true,
    });
  } else if ("isRunning" in sandbox) {
    // Fallback for non-getter isRunning
    (adapted as any).isRunning = sb.isRunning;
  }

  // Preserve initialize method if present
  if (typeof sb.initialize === "function") {
    (adapted as any).initialize = () => sb.initialize();
  }

  // Preserve uploadFiles and downloadFiles (required for SandboxInstance)
  if (typeof sb.uploadFiles === "function") {
    (adapted as any).uploadFiles = (files: any) => sb.uploadFiles(files);
  }
  if (typeof sb.downloadFiles === "function") {
    (adapted as any).downloadFiles = (paths: any) => sb.downloadFiles(paths);
  }

  return adapted as SandboxInstanceV2;
}
