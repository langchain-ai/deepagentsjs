/**
 * Worker-side JavaScript runtime for PTC.
 *
 * This code is injected into Web Workers or Node.js Worker Threads before
 * the user's script. It provides `toolCall()`, `spawnAgent()`, and
 * `console.log` via `postMessage` IPC — no filesystem or process.stderr needed.
 *
 * Communication protocol (Worker <-> Main thread):
 *
 *   Worker  -> Main:  { type: "tool_call", uuid, name, input }
 *   Main    -> Worker: { type: "tool_result", uuid, ok, result?, error? }
 *   Worker  -> Main:  { type: "log", args }
 *   Worker  -> Main:  { type: "result", ok, value?, error? }
 */

/**
 * Runtime source code evaluated inside the Worker.
 *
 * Uses an async message-based IPC pattern:
 * - `toolCall(name, input)` returns a Promise that resolves when the
 *   main thread replies with the matching uuid.
 * - `spawnAgent(description, type)` is sugar for `toolCall("task", {...})`.
 * - `console.log/warn/error` are overridden to forward output to the main thread.
 */
export const WORKER_JS_RUNTIME = `
// ── PTC Worker Runtime ──────────────────────────────────────────────
"use strict";

const __da_pending = new Map();

// Detect environment: Node.js worker_threads vs Web Worker
const __da_isNode = typeof require === "function" && typeof self === "undefined";
let __da_port;
let __da_postMessage;

if (__da_isNode) {
  const { parentPort } = require("worker_threads");
  __da_port = parentPort;
  __da_postMessage = (msg) => parentPort.postMessage(msg);
  parentPort.on("message", __da_onMessage);
} else {
  __da_port = self;
  __da_postMessage = (msg) => self.postMessage(msg);
  self.onmessage = (e) => __da_onMessage(e.data);
}

function __da_onMessage(msg) {
  if (msg.type === "tool_result" && __da_pending.has(msg.uuid)) {
    const { resolve, reject } = __da_pending.get(msg.uuid);
    __da_pending.delete(msg.uuid);
    if (msg.ok) resolve(msg.result);
    else reject(new Error(msg.error || "Tool call failed"));
  }
}

function __da_uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Call a host-side tool. Returns a Promise.
 * Use with await or Promise.all() for parallelism.
 */
function toolCall(name, input) {
  input = input || {};
  const uuid = __da_uuid();
  return new Promise((resolve, reject) => {
    __da_pending.set(uuid, { resolve, reject });
    __da_postMessage({ type: "tool_call", uuid, name, input });
  });
}

/**
 * Spawn a subagent. Returns a Promise with the agent's text response.
 */
function spawnAgent(description, agentType) {
  return toolCall("task", {
    description: description,
    subagent_type: agentType || "general-purpose",
  });
}

// Override console to forward output to main thread
const __da_origConsole = {
  log: typeof console !== "undefined" ? console.log : () => {},
  warn: typeof console !== "undefined" ? console.warn : () => {},
  error: typeof console !== "undefined" ? console.error : () => {},
};

const __da_logs = [];

function __da_formatArgs(args) {
  return args
    .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
    .join(" ");
}

console.log = (...args) => {
  const line = __da_formatArgs(args);
  __da_logs.push(line);
  __da_postMessage({ type: "log", text: line });
};
console.warn = (...args) => {
  const line = "[warn] " + __da_formatArgs(args);
  __da_logs.push(line);
  __da_postMessage({ type: "log", text: line });
};
console.error = (...args) => {
  const line = "[error] " + __da_formatArgs(args);
  __da_logs.push(line);
  __da_postMessage({ type: "log", text: line });
};

// Make available as globals
if (typeof globalThis !== "undefined") {
  globalThis.toolCall = toolCall;
  globalThis.spawnAgent = spawnAgent;
}
`;

/**
 * Wraps user code in an async IIFE so top-level await works,
 * and sends the result (or error) back to the main thread.
 */
export function wrapUserCode(code: string): string {
  return `${WORKER_JS_RUNTIME}

// ── User code (async IIFE) ──────────────────────────────────────────
(async () => {
  try {
    const __da_userResult = await (async () => {
${code}
    })();
    __da_postMessage({ type: "result", ok: true, value: __da_userResult !== undefined ? String(__da_userResult) : undefined, logs: __da_logs });
  } catch (__da_err) {
    __da_postMessage({ type: "result", ok: false, error: __da_err?.message || String(__da_err), logs: __da_logs });
  }
})();
`;
}
