/**
 * Worker-side JavaScript runtime for PTC.
 *
 * Security model:
 * - **Node.js Worker Threads**: User code runs inside a `vm.createContext()`
 *   with only whitelisted globals. No `require`, `process`, `fs`, `Buffer`,
 *   `fetch`, or `import` — only `toolCall`, `spawnAgent`, `console`, `JSON`,
 *   `Math`, `Promise`, `Array`, `Object`, etc.
 * - **Web Workers**: Already restricted by the browser — no filesystem,
 *   no `require`, no `process`. Code runs directly in the Worker scope.
 *
 * Communication protocol (Worker <-> Main thread):
 *   Worker  -> Main:  { type: "tool_call", uuid, name, input }
 *   Main    -> Worker: { type: "tool_result", uuid, ok, result?, error? }
 *   Worker  -> Main:  { type: "log", text }
 *   Worker  -> Main:  { type: "result", ok, value?, error? }
 */

/**
 * Node.js Worker Thread bootstrap.
 *
 * Sets up the IPC bridge (parentPort), then runs the user's code inside
 * a restricted `vm.createContext()` that only exposes safe globals +
 * PTC functions. This prevents the agent's code from accessing `require`,
 * `process`, `fs`, network APIs, or any Node.js built-ins.
 */
export const NODE_WORKER_BOOTSTRAP = `
"use strict";
const { parentPort } = require("worker_threads");
const vm = require("vm");

const __da_pending = new Map();
const __da_logs = [];

function __da_postMessage(msg) { parentPort.postMessage(msg); }

parentPort.on("message", (msg) => {
  if (msg.type === "tool_result" && __da_pending.has(msg.uuid)) {
    const { resolve, reject } = __da_pending.get(msg.uuid);
    __da_pending.delete(msg.uuid);
    if (msg.ok) resolve(msg.result);
    else reject(new Error(msg.error || "Tool call failed"));
  }
});

function __da_uuid() {
  return require("crypto").randomUUID();
}

function __da_formatArgs(args) {
  return args
    .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
    .join(" ");
}

// ── PTC functions exposed to the sandbox ────────────────────────────

function toolCall(name, input) {
  input = input || {};
  const uuid = __da_uuid();
  return new Promise((resolve, reject) => {
    __da_pending.set(uuid, { resolve, reject });
    __da_postMessage({ type: "tool_call", uuid, name, input });
  });
}

function spawnAgent(description, agentType) {
  return toolCall("task", {
    description: description,
    subagent_type: agentType || "general-purpose",
  });
}

const __da_console = {
  log: (...args) => {
    const line = __da_formatArgs(args);
    __da_logs.push(line);
    __da_postMessage({ type: "log", text: line });
  },
  warn: (...args) => {
    const line = "[warn] " + __da_formatArgs(args);
    __da_logs.push(line);
    __da_postMessage({ type: "log", text: line });
  },
  error: (...args) => {
    const line = "[error] " + __da_formatArgs(args);
    __da_logs.push(line);
    __da_postMessage({ type: "log", text: line });
  },
};

// ── fetch proxy (only if network policy is configured) ──────────────
// __DA_HAS_FETCH__ is replaced with "true" or "false" at build time
const __da_hasFetch = __DA_HAS_FETCH__;

function fetch(url, init) {
  if (!__da_hasFetch) return Promise.reject(new Error("fetch is not available (no network policy configured)"));
  const uuid = __da_uuid();
  return new Promise((resolve, reject) => {
    __da_pending.set(uuid, { resolve, reject });
    __da_postMessage({
      type: "fetch",
      uuid,
      url: String(url),
      method: (init && init.method) || "GET",
      headers: (init && init.headers) || {},
      body: (init && init.body) || undefined,
    });
  });
}

// ── Run user code in a restricted VM context ────────────────────────

const __da_sandbox = vm.createContext({
  // PTC globals
  toolCall,
  spawnAgent,
  fetch: __da_hasFetch ? fetch : undefined,
  console: __da_console,

  // Safe JS built-ins
  Promise,
  JSON,
  Math,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Date,
  RegExp,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  URIError,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURI,
  decodeURI,
  encodeURIComponent,
  decodeURIComponent,
  undefined,
  NaN,
  Infinity,
  globalThis: undefined,
  // Timers (needed for Promise resolution polling in some edge cases)
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});

const __da_userCode = "@@SPLIT@@";

const __da_script = new vm.Script(
  "(async () => {\\n" +
  "  try {\\n" +
  "    const __result = await (async () => {\\n" +
  __da_userCode + "\\n" +
  "    })();\\n" +
  "    return { ok: true, value: __result !== undefined ? String(__result) : undefined };\\n" +
  "  } catch (__err) {\\n" +
  "    return { ok: false, error: __err?.message || String(__err) };\\n" +
  "  }\\n" +
  "})()",
  { filename: "js_eval" }
);

const __da_promise = __da_script.runInContext(__da_sandbox);
__da_promise.then((res) => {
  __da_postMessage({ type: "result", ok: res.ok, value: res.value, error: res.error, logs: __da_logs });
}).catch((err) => {
  __da_postMessage({ type: "result", ok: false, error: err?.message || String(err), logs: __da_logs });
});
`;

/**
 * Web Worker bootstrap.
 *
 * Web Workers are already restricted (no `require`, `process`, `fs`).
 * We just set up the IPC bridge and run the user's code directly.
 */
export const WEB_WORKER_BOOTSTRAP = `
"use strict";

const __da_pending = new Map();
const __da_logs = [];

function __da_postMessage(msg) { self.postMessage(msg); }

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "tool_result" && __da_pending.has(msg.uuid)) {
    const { resolve, reject } = __da_pending.get(msg.uuid);
    __da_pending.delete(msg.uuid);
    if (msg.ok) resolve(msg.result);
    else reject(new Error(msg.error || "Tool call failed"));
  }
};

function __da_uuid() {
  return crypto.randomUUID();
}

function __da_formatArgs(args) {
  return args
    .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
    .join(" ");
}

function toolCall(name, input) {
  input = input || {};
  const uuid = __da_uuid();
  return new Promise((resolve, reject) => {
    __da_pending.set(uuid, { resolve, reject });
    __da_postMessage({ type: "tool_call", uuid, name, input });
  });
}

function spawnAgent(description, agentType) {
  return toolCall("task", {
    description: description,
    subagent_type: agentType || "general-purpose",
  });
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

// fetch proxy (only if network policy is configured)
const __da_hasFetch_web = __DA_HAS_FETCH_WEB__;

if (__da_hasFetch_web) {
  const __origFetch = typeof self.fetch === "function" ? self.fetch.bind(self) : null;
  self.fetch = function(url, init) {
    const uuid = __da_uuid();
    return new Promise((resolve, reject) => {
      __da_pending.set(uuid, { resolve, reject });
      __da_postMessage({
        type: "fetch",
        uuid,
        url: String(url),
        method: (init && init.method) || "GET",
        headers: (init && init.headers) || {},
        body: (init && init.body) || undefined,
      });
    });
  };
} else {
  self.fetch = function() { return Promise.reject(new Error("fetch is not available (no network policy configured)")); };
}
`;

/**
 * Build the complete Worker code by injecting the user's code into the
 * appropriate bootstrap (Node.js with vm sandbox, or Web Worker).
 */
export function wrapUserCode(
  code: string,
  impl: "node" | "web",
  options: { hasFetch?: boolean } = {},
): string {
  const hasFetch = options.hasFetch ?? false;

  if (impl === "node") {
    const escaped = JSON.stringify(code);
    let bootstrap = NODE_WORKER_BOOTSTRAP.split("__DA_HAS_FETCH__").join(String(hasFetch));
    const [before, after] = bootstrap.split('"@@SPLIT@@"');
    return before + escaped + after;
  }

  // Web Worker: run code directly (already sandboxed by the browser)
  const webBootstrap = WEB_WORKER_BOOTSTRAP.split("__DA_HAS_FETCH_WEB__").join(String(hasFetch));
  return `${webBootstrap}

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
