/**
 * Extended state for coding agent with approval operation caching.
 */

import { z } from "zod";
import * as path from "path";
import { DeepAgentState } from "../../src/state.js";
import { FILE_EDIT_COMMANDS } from "./constants.js";

// Define the approved operations schema
const ApprovedOperationsSchema = z.object({
  cached_approvals: z.set(z.string()).default(() => new Set<string>())
}).optional();

// Extend the base DeepAgentState with coding-specific fields
export const CodingAgentState = DeepAgentState.extend({
  approved_operations: ApprovedOperationsSchema
});

export type CodingAgentStateType = z.infer<typeof CodingAgentState>;

/**
 * Helper functions for the coding agent state
 */
export class CodingAgentStateHelpers {
  /**
   * Generate a cache key for command approval based on command type and target directory.
   */
  static getApprovalKey(command: string, args: Record<string, any>): string {
    let targetDir: string | null = null;
    
    if (FILE_EDIT_COMMANDS.has(command)) {
      const filePath = args.file_path || args.path;
      if (filePath) {
        targetDir = path.dirname(path.resolve(filePath));
      }
    } else if (command === "execute_bash") {
      targetDir = args.cwd || process.cwd();
    } else if (["ls", "glob", "grep"].includes(command)) {
      targetDir = args.path || args.directory || process.cwd();
    }
    
    if (!targetDir) {
      targetDir = process.cwd();
    }
    
    // Create a cache key: command_type:normalized_directory
    const normalizedDir = path.normalize(targetDir);
    return `${command}:${normalizedDir}`;
  }
  
  /**
   * Check if a command/directory combination has been previously approved.
   */
  static isOperationApproved(
    state: CodingAgentStateType, 
    command: string, 
    args: Record<string, any>
  ): boolean {
    if (!state.approved_operations || !state.approved_operations.cached_approvals) {
      return false;
    }
    
    const approvalKey = this.getApprovalKey(command, args);
    return state.approved_operations.cached_approvals.has(approvalKey);
  }
  
  /**
   * Add a command/directory combination to the approved operations cache.
   */
  static addApprovedOperation(
    state: CodingAgentStateType, 
    command: string, 
    args: Record<string, any>
  ): void {
    if (!state.approved_operations) {
      state.approved_operations = { cached_approvals: new Set<string>() };
    }
    
    if (!state.approved_operations.cached_approvals) {
      state.approved_operations.cached_approvals = new Set<string>();
    }
    
    const approvalKey = this.getApprovalKey(command, args);
    state.approved_operations.cached_approvals.add(approvalKey);
  }
}