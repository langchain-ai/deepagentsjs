/**
 * Runtime libraries injected into sandbox environments for PTC.
 *
 * Each runtime provides `tool_call` and `spawn_agent` functions that
 * communicate with the host PTC engine via stdout markers + file-based
 * IPC responses.
 *
 * Protocol:
 *   Request:  Script writes __DA_REQ_START__<uuid>\n<json>\n__DA_REQ_END__ to stdout
 *   Response: Host writes to /tmp/.da_ipc/res/<uuid> with status line + payload
 */

export const IPC_DIR = "/tmp/.da_ipc";
export const IPC_RES_DIR = `${IPC_DIR}/res`;

/**
 * Single-line marker format: `__DA_REQ__<uuid> <json_payload>\n`
 *
 * Using a single line ensures each `printf` call maps to a single write()
 * syscall (≤ PIPE_BUF), preventing interleaving when multiple background
 * jobs call tool_call concurrently.
 */
export const REQ_LINE_MARKER = "__DA_REQ__";

/** @deprecated kept for backward compatibility with tests */
export const REQ_START_MARKER = "__DA_REQ_START__";
/** @deprecated kept for backward compatibility with tests */
export const REQ_END_MARKER = "__DA_REQ_END__";

export const BASH_RUNTIME = `#!/bin/bash
# DeepAgents PTC Runtime — auto-injected, do not modify
__DA_IPC_DIR="${IPC_DIR}"
mkdir -p "$__DA_IPC_DIR/res" 2>/dev/null

__da_uuid() {
  if [ -f /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x' \\
      $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM $RANDOM
  fi
}

tool_call() {
  local tool_name="\$1"
  local tool_input="\${2:-\\{\\}}"
  local rid
  rid=$(__da_uuid)

  local res_file="$__DA_IPC_DIR/res/\${rid}"

  # Single-line marker to stderr (atomic under PIPE_BUF, safe for concurrency).
  # Format: __DA_REQ__<uuid> <json>\n
  printf '${REQ_LINE_MARKER}%s {"type":"tool_call","name":"%s","input":%s}\\n' \\
    "\${rid}" "\${tool_name}" "\${tool_input}" >&2

  # Poll for response file
  while [ ! -f "\${res_file}" ]; do
    sleep 0.05 2>/dev/null || sleep 1
  done

  # Read status (line 1) and result (rest)
  local status
  status=$(head -1 "\${res_file}")
  local result
  result=$(tail -n +2 "\${res_file}")
  rm -f "\${res_file}"

  if [ "\${status}" = "1" ]; then
    echo "Error: \${result}" >&2
    return 1
  fi
  echo "\${result}"
}

spawn_agent() {
  local description="\$1"
  local agent_type="\${2:-general-purpose}"
  tool_call "task" "{\\"description\\":\\"\${description}\\",\\"subagent_type\\":\\"\${agent_type}\\"}"
}
`;

export const PYTHON_RUNTIME = `# DeepAgents PTC Runtime — auto-injected, do not modify
import json, os, time, uuid, sys

_IPC_DIR = "${IPC_DIR}"
_IPC_RES_DIR = os.path.join(_IPC_DIR, "res")
os.makedirs(_IPC_RES_DIR, exist_ok=True)

def tool_call(name: str, input: dict = None) -> str:
    if input is None:
        input = {}
    rid = str(uuid.uuid4())
    res_file = os.path.join(_IPC_RES_DIR, rid)

    req = json.dumps({"type": "tool_call", "name": name, "input": input})
    sys.stderr.write("${REQ_LINE_MARKER}" + rid + " " + req + "\\n")
    sys.stderr.flush()

    wait = 0.05
    while not os.path.exists(res_file):
        time.sleep(wait)
        wait = min(wait * 1.5, 0.5)

    with open(res_file) as f:
        status = f.readline().strip()
        result = f.read()
    os.remove(res_file)

    if status == "1":
        raise RuntimeError(result)
    return result

def spawn_agent(description: str, agent_type: str = "general-purpose") -> str:
    return tool_call("task", {"description": description, "subagent_type": agent_type})
`;

export const NODE_RUNTIME = `// DeepAgents PTC Runtime — auto-injected, do not modify
const __da_fs = require("fs");
const __da_path = require("path");
const __da_crypto = require("crypto");

const __DA_IPC_DIR = "${IPC_DIR}";
const __DA_IPC_RES_DIR = __da_path.join(__DA_IPC_DIR, "res");
try { __da_fs.mkdirSync(__DA_IPC_RES_DIR, { recursive: true }); } catch {}

function toolCall(name, input) {
  input = input || {};
  const rid = __da_crypto.randomUUID();
  const resFile = __da_path.join(__DA_IPC_RES_DIR, rid);

  const req = JSON.stringify({ type: "tool_call", name, input });
  process.stderr.write("${REQ_LINE_MARKER}" + rid + " " + req + "\\n");

  // Busy-wait for response (sync context)
  let wait = 5;
  while (!__da_fs.existsSync(resFile)) {
    const start = Date.now();
    while (Date.now() - start < wait) { /* spin */ }
    wait = Math.min(wait * 2, 500);
  }

  const content = __da_fs.readFileSync(resFile, "utf8");
  __da_fs.unlinkSync(resFile);

  const nl = content.indexOf("\\n");
  const status = content.slice(0, nl);
  const result = content.slice(nl + 1);

  if (status === "1") throw new Error(result);
  return result;
}

function spawnAgent(description, agentType) {
  return toolCall("task", { description, subagent_type: agentType || "general-purpose" });
}

module.exports = { toolCall, spawnAgent };
`;

export const RUNTIME_SETUP_COMMAND =
  `mkdir -p ${IPC_RES_DIR} 2>/dev/null; `;
