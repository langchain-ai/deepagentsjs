/**
 * Streaming utilities and helpers for Deep Agents
 * 
 * Deep Agents inherently supports streaming through the underlying createReactAgent.
 * This module provides convenience methods and helpers for common streaming patterns.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { isAIMessageChunk } from "@langchain/core/messages";
import type { DeepAgentStateType } from "./types.js";

/**
 * Stream mode type for Deep Agents
 * Supports all LangGraph streaming modes plus custom combinations
 */
export type StreamMode = 
  | "values"      // Full state after each node
  | "updates"     // State updates after each node
  | "messages"    // LLM token streaming (requires @langchain/langgraph>=0.2.20)
  | "custom"      // Custom data streaming
  | "debug";      // Debug information

/**
 * Stream configuration for Deep Agents
 */
export interface DeepAgentStreamConfig extends LangGraphRunnableConfig {
  /**
   * Streaming mode(s) to use
   * Can be a single mode or array of modes for multiple streams
   */
  streamMode?: StreamMode | StreamMode[];
  
  /**
   * For streamEvents, include only events with these tags
   */
  includeTags?: string[];
  
  /**
   * For streamEvents, exclude events with these tags
   */
  excludeTags?: string[];
}

/**
 * Result type for streamed values
 */
export interface StreamedUpdate<T = DeepAgentStateType> {
  /**
   * Type of stream update
   */
  type: StreamMode;
  
  /**
   * The actual data being streamed
   */
  data: T | Partial<T> | BaseMessage | string | any;
  
  /**
   * Metadata about the stream chunk
   */
  metadata?: {
    node?: string;
    step?: number;
    timestamp?: string;
  };
}

/**
 * Helper to format streamed messages for display
 */
export function formatStreamedMessage(message: BaseMessage | any): string {
  // Check if it's an AI message chunk with proper typing
  if (message && typeof message === 'object' && 'content' in message) {
    // Check for tool call chunks
    if ('tool_call_chunks' in message && Array.isArray(message.tool_call_chunks) && message.tool_call_chunks.length > 0) {
      return `[Tool Call: ${message.tool_call_chunks[0].name || 'unknown'}]`;
    }
    return message.content?.toString() || '';
  }
  return '';
}

/**
 * Helper to check if a stream chunk contains LLM tokens
 */
export function isLLMTokenChunk(chunk: any): boolean {
  return (
    chunk &&
    typeof chunk === 'object' &&
    'messages' in chunk &&
    Array.isArray(chunk.messages) &&
    chunk.messages.length > 0 &&
    isAIMessageChunk(chunk.messages[chunk.messages.length - 1])
  );
}

/**
 * Helper to extract todos from stream updates
 */
export function extractTodosFromUpdate(update: any): any[] | null {
  if (update && typeof update === 'object' && 'todos' in update) {
    return update.todos;
  }
  return null;
}

/**
 * Helper to extract files from stream updates
 */
export function extractFilesFromUpdate(update: any): Record<string, string> | null {
  if (update && typeof update === 'object' && 'files' in update) {
    return update.files;
  }
  return null;
}

/**
 * Stream handler interface for custom processing
 */
export interface StreamHandler<T = DeepAgentStateType> {
  /**
   * Called when a new chunk is received
   */
  onChunk?: (chunk: StreamedUpdate<T>) => void | Promise<void>;
  
  /**
   * Called when todos are updated
   */
  onTodosUpdate?: (todos: any[]) => void | Promise<void>;
  
  /**
   * Called when files are updated
   */
  onFilesUpdate?: (files: Record<string, string>) => void | Promise<void>;
  
  /**
   * Called when LLM tokens are streamed
   */
  onToken?: (token: string) => void | Promise<void>;
  
  /**
   * Called when streaming completes
   */
  onComplete?: (finalState: T) => void | Promise<void>;
  
  /**
   * Called on error
   */
  onError?: (error: Error) => void | Promise<void>;
}

/**
 * Process a stream with custom handlers
 * This is a convenience function for common streaming patterns
 */
export async function processStream<T = DeepAgentStateType>(
  stream: AsyncIterable<any>,
  handler: StreamHandler<T>
): Promise<T | null> {
  let finalState: T | null = null;
  
  try {
    for await (const chunk of stream) {
      // Handle different chunk formats
      if (Array.isArray(chunk)) {
        // Multiple stream modes: [mode, data]
        const [mode, data] = chunk;
        
        const streamedUpdate: StreamedUpdate<T> = {
          type: mode as StreamMode,
          data: data,
        };
        
        await handler.onChunk?.(streamedUpdate);
        
        // Check for specific updates
        if (mode === 'updates' || mode === 'values') {
          const todos = extractTodosFromUpdate(data);
          if (todos) {
            await handler.onTodosUpdate?.(todos);
          }
          
          const files = extractFilesFromUpdate(data);
          if (files) {
            await handler.onFilesUpdate?.(files);
          }
          
          if (mode === 'values') {
            finalState = data as T;
          }
        } else if (mode === 'messages') {
          const token = formatStreamedMessage(data);
          if (token) {
            await handler.onToken?.(token);
          }
        }
      } else {
        // Single stream mode
        const streamedUpdate: StreamedUpdate<T> = {
          type: 'updates', // Default to updates
          data: chunk,
        };
        
        await handler.onChunk?.(streamedUpdate);
        
        const todos = extractTodosFromUpdate(chunk);
        if (todos) {
          await handler.onTodosUpdate?.(todos);
        }
        
        const files = extractFilesFromUpdate(chunk);
        if (files) {
          await handler.onFilesUpdate?.(files);
        }
        
        // Try to extract final state
        if ('messages' in chunk) {
          finalState = chunk as T;
        }
      }
    }
    
    if (finalState) {
      await handler.onComplete?.(finalState);
    }
    
    return finalState;
  } catch (error) {
    await handler.onError?.(error as Error);
    throw error;
  }
}

/**
 * Create a simple token accumulator for LLM streaming
 */
export class TokenAccumulator {
  private tokens: string[] = [];
  
  /**
   * Add a token to the accumulator
   */
  add(token: string): void {
    this.tokens.push(token);
  }
  
  /**
   * Get all accumulated tokens as a string
   */
  getText(): string {
    return this.tokens.join('');
  }
  
  /**
   * Get the last N tokens
   */
  getLastTokens(n: number): string {
    return this.tokens.slice(-n).join('');
  }
  
  /**
   * Clear all tokens
   */
  clear(): void {
    this.tokens = [];
  }
  
  /**
   * Get token count
   */
  count(): number {
    return this.tokens.length;
  }
}

/**
 * Streaming mode presets for common use cases
 */
export const StreamingPresets = {
  /**
   * Full state streaming - good for debugging
   */
  FULL_STATE: { streamMode: "values" as const },
  
  /**
   * Delta updates only - good for efficient updates
   */
  UPDATES_ONLY: { streamMode: "updates" as const },
  
  /**
   * LLM token streaming - good for real-time chat
   */
  LLM_TOKENS: { streamMode: "messages" as const },
  
  /**
   * Everything - full observability
   */
  ALL: { streamMode: ["values", "updates", "messages"] as const },
  
  /**
   * Production streaming - updates and tokens
   */
  PRODUCTION: { streamMode: ["updates", "messages"] as const },
} as const;