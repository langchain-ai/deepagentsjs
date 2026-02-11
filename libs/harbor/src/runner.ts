#!/usr/bin/env node
/**
 * Harbor runner: Node.js entry point spawned by the Python wrapper.
 *
 * Protocol:
 * 1. Reads an "init" message from stdin with instruction, model, etc.
 * 2. Creates an RpcSandbox and a DeepAgent
 * 3. Invokes the agent with the instruction
 * 4. Sends a "done" message to stdout with serialized messages
 *
 * All logging goes to stderr to keep stdout clean for the JSON-RPC protocol.
 *
 * @packageDocumentation
 */

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { createDeepAgent } from "deepagents";

import { RpcSandbox } from "./rpc-sandbox.js";
import {
  type InitMessage,
  type SerializedMessage,
  createStdinReader,
  log,
  sendMessage,
} from "./rpc-protocol.js";

/**
 * Serialize a LangChain BaseMessage into a simple JSON-friendly format
 * for transfer to Python. Python will convert these into ATIF trajectory steps.
 */
function serializeMessage(msg: BaseMessage): SerializedMessage {
  // Determine role
  let role: string;
  if (HumanMessage.isInstance(msg)) {
    role = "human";
  } else if (AIMessage.isInstance(msg)) {
    role = "ai";
  } else if (ToolMessage.isInstance(msg)) {
    role = "tool";
  } else {
    role = "system";
  }

  // Extract text content
  const content =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

  const serialized: SerializedMessage = { role, content };

  // AI message specifics
  if (AIMessage.isInstance(msg)) {
    // Token usage
    const usage = msg.usage_metadata;
    if (usage) {
      serialized.usage = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
      };
    }

    // Tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      serialized.toolCalls = msg.tool_calls.map((tc) => ({
        id: tc.id ?? "",
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
    }
  }

  // Tool message specifics
  if (ToolMessage.isInstance(msg)) {
    serialized.toolCallId = msg.tool_call_id;
  }

  return serialized;
}

/**
 * Wait for the init message from Python.
 * Returns a promise that resolves with the init message, or rejects
 * if no init message arrives within the timeout period.
 */
async function waitForInit(
  sandbox: RpcSandbox,
  timeoutMs = 30_000,
): Promise<InitMessage> {
  return new Promise<InitMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for init message from Python after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    sandbox.setMessageHandler((msg) => {
      if (msg.type === "init") {
        clearTimeout(timer);
        resolve(msg as InitMessage);
      }
    });
  });
}

/**
 * Main entry point for the Harbor JS runner.
 */
async function main(): Promise<void> {
  log("Starting Harbor JS runner...");

  // Create the stdin reader
  const reader = createStdinReader();

  // Create sandbox with a temporary ID (will be updated after init)
  const sandbox = new RpcSandbox("pending", reader);
  sandbox.startListening();

  // Wait for the init message from Python
  log("Waiting for init message...");
  const init = await waitForInit(sandbox);
  log(`Received init: model=${init.model}, sessionId=${init.sessionId}`);

  // Update sandbox ID to the real session ID
  // We need to create a new sandbox with the correct ID
  // since `id` is readonly, we create a new one
  sandbox.dispose();

  const rpcSandbox = new RpcSandbox(init.sessionId, reader);
  rpcSandbox.startListening();

  try {
    // Create the deep agent with the RPC sandbox backend
    const agent = createDeepAgent({
      model: init.model,
      backend: rpcSandbox,
      systemPrompt: init.systemPrompt,
    });

    log("Agent created, invoking with instruction...");

    // Invoke the agent
    const result = await agent.invoke(
      {
        messages: [{ role: "user", content: init.instruction }],
      },
      {
        configurable: {
          thread_id: init.sessionId,
        },
        recursionLimit: 10_000,
      },
    );

    // Serialize all messages
    const messages: SerializedMessage[] = [];
    const rawMessages = result.messages as BaseMessage[];

    for (const msg of rawMessages) {
      messages.push(serializeMessage(msg));
    }

    log(`Agent completed. ${messages.length} messages in history.`);

    // Send the done message
    sendMessage({
      type: "done",
      messages,
    });
  } catch (error) {
    const isError =
      typeof error === "object" && error !== null && "message" in error;
    const errorMsg = isError ? (error as Error).message : String(error);
    const errorStack = isError ? (error as Error).stack : undefined;

    log(`Agent error: ${errorMsg}`);

    sendMessage({
      type: "error",
      message: errorMsg,
      stack: errorStack,
    });

    process.exitCode = 1;
  } finally {
    // Flush all pending LangSmith traces and LangChain callbacks before the
    // process exits.  Without this, Python may terminate the child process
    // before background trace batches have been sent.
    await awaitAllCallbacks();

    rpcSandbox.dispose();
    reader.close();
    // Destroy stdin so the event loop can drain and the process exits cleanly.
    // Without this, Node keeps waiting for more data on the piped stdin from Python.
    process.stdin.destroy();
  }
}

// Run the main function
main().catch((error) => {
  log(`Fatal error: ${error}`);
  process.exitCode = 1;
});
