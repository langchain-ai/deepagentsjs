/**
 * Integration test: PTC engine with a real bash process.
 *
 * Creates a minimal sandbox that spawns real bash processes to verify
 * the full IPC round-trip: bash runtime upload → tool_call from script →
 * stdout marker detection → host tool invocation → response file → bash reads result.
 *
 * No LLM or external sandbox SDK needed.
 */

import { describe, it, expect, afterEach } from "vitest";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tool } from "langchain";
import { z } from "zod/v4";

import type {
  SandboxBackendProtocol,
  InteractiveProcess,
  ExecuteResponse,
  FileData,
  WriteResult,
  FileUploadResponse,
  FileDownloadResponse,
} from "../backends/protocol.js";
import { PtcExecutionEngine } from "./engine.js";

/**
 * Minimal real-filesystem sandbox backed by a temp directory.
 * Implements just enough of SandboxBackendProtocol + spawnInteractive()
 * for the PTC engine to work.
 */
class TempDirSandbox implements SandboxBackendProtocol {
  readonly id = `test-${Date.now()}`;
  readonly dir: string;

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ptc-test-"));
  }

  async execute(command: string): Promise<ExecuteResponse> {
    return new Promise((resolve) => {
      const child = cp.spawn("/bin/bash", ["-c", command], { cwd: this.dir });
      const chunks: string[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
      child.on("close", (code) =>
        resolve({ output: chunks.join(""), exitCode: code, truncated: false }),
      );
      child.on("error", (err) =>
        resolve({ output: err.message, exitCode: 1, truncated: false }),
      );
    });
  }

  async spawnInteractive(command: string): Promise<InteractiveProcess> {
    const dir = this.dir;
    const child = cp.spawn("/bin/bash", ["-c", command], {
      cwd: dir,
      env: { ...process.env, HOME: process.env.HOME },
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    async function* toAsyncIterable(
      stream: NodeJS.ReadableStream,
    ): AsyncGenerator<Uint8Array> {
      for await (const chunk of stream) {
        // eslint-disable-next-line no-instanceof/no-instanceof
        yield chunk instanceof Buffer
          ? new Uint8Array(chunk)
          : (chunk as unknown as Uint8Array);
      }
    }

    return {
      stdout: toAsyncIterable(child.stdout!),
      stderr: toAsyncIterable(child.stderr!),
      async writeFile(filePath: string, content: string) {
        const full = path.isAbsolute(filePath)
          ? filePath
          : path.join(dir, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      },
      async waitForExit() {
        return { exitCode: await exitPromise };
      },
      async kill() {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      },
    };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return files.map(([p, content]) => {
      const full = path.join(this.dir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return { path: p, error: null };
    });
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return paths.map((p) => {
      try {
        const full = path.join(this.dir, p);
        return { path: p, content: fs.readFileSync(full), error: null };
      } catch {
        return { path: p, content: null, error: "file_not_found" as const };
      }
    });
  }

  // Stubs for the rest of BackendProtocol
  async lsInfo() {
    return [];
  }
  async read() {
    return "";
  }
  async readRaw(): Promise<FileData> {
    return { content: [], created_at: "", modified_at: "" };
  }
  async grepRaw() {
    return [];
  }
  async globInfo() {
    return [];
  }
  async write(_p: string, _c: string): Promise<WriteResult> {
    return { path: _p };
  }
  async edit() {
    return { error: "not implemented" };
  }

  cleanup() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

describe("PTC engine integration (real bash)", { timeout: 30_000 }, () => {
  const sandboxes: TempDirSandbox[] = [];

  function makeSandbox() {
    const sb = new TempDirSandbox();
    sandboxes.push(sb);
    return sb;
  }

  afterEach(() => {
    for (const sb of sandboxes) sb.cleanup();
    sandboxes.length = 0;
  });

  it("single tool_call round-trip", async () => {
    const sandbox = makeSandbox();

    const greetTool = tool(
      async (input: { name: string }) => `Hello, ${input.name}!`,
      {
        name: "greet",
        description: "Greet someone",
        schema: z.object({ name: z.string() }),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [greetTool]);
    const result = await engine.execute(
      'msg=$(tool_call greet \'{"name":"World"}\')\necho "RESULT=$msg"',
    );

    expect(result.output).toContain("RESULT=Hello, World!");
    expect(result.exitCode).toBe(0);
  });

  it("10 parallel tool_calls via background jobs", async () => {
    const sandbox = makeSandbox();

    const upperTool = tool(
      async (input: { id: number; value: string }) =>
        JSON.stringify({ id: input.id, upper: input.value.toUpperCase() }),
      {
        name: "transform",
        description: "uppercase a value",
        schema: z.object({ id: z.number(), value: z.string() }),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [upperTool]);

    const script = `
mkdir -p /tmp/results
for i in $(seq 1 10); do
  ( result=$(tool_call transform '{"id":'$i',"value":"item_'$i'"}')
    echo "$result" > /tmp/results/$i.txt
  ) &
done
wait

echo "=== ALL DONE ==="
for i in $(seq 1 10); do
  cat /tmp/results/$i.txt
done
COUNT=$(ls /tmp/results/*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "TOTAL=$COUNT files"
`;

    const result = await engine.execute(script);

    expect(result.output).toContain("=== ALL DONE ===");
    expect(result.output).toContain('"upper":"ITEM_1"');
    expect(result.output).toContain('"upper":"ITEM_5"');
    expect(result.output).toContain('"upper":"ITEM_10"');
    expect(result.output).toContain("TOTAL=10 files");
  });

  it("tool_call error is surfaced in bash", async () => {
    const sandbox = makeSandbox();

    const failTool = tool(
      async () => {
        throw new Error("boom");
      },
      {
        name: "fail",
        description: "always fails",
        schema: z.object({}),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [failTool]);
    const result = await engine.execute(
      "tool_call fail '{}'\necho \"exit_code=$?\"",
    );

    expect(result.output).toContain("Error:");
    expect(result.output).toContain("exit_code=1");
  });

  it("unknown tool returns error", async () => {
    const sandbox = makeSandbox();
    const engine = new PtcExecutionEngine(sandbox, []);
    const result = await engine.execute(
      "tool_call no_such_tool '{}'\necho \"exit_code=$?\"",
    );

    expect(result.output).toContain("Unknown tool: no_such_tool");
    expect(result.output).toContain("exit_code=1");
  });

  it("spawn_agent handles multi-line descriptions (JSON escaping)", async () => {
    const sandbox = makeSandbox();

    const taskTool = tool(
      async (input: { description: string; subagent_type: string }) =>
        `Analysed: ${input.description.slice(0, 50)}... (agent=${input.subagent_type})`,
      {
        name: "task",
        description: "Spawn a subagent",
        schema: z.object({ description: z.string(), subagent_type: z.string() }),
      },
    );

    const engine = new PtcExecutionEngine(sandbox, [taskTool]);

    const script = `
cat > /tmp/report.txt << 'EOF'
Line 1: summary stats
Line 2: more "quoted" data
Line 3: backslash \\ test
EOF
result=$(spawn_agent "Analyse this report: $(cat /tmp/report.txt)" "analyst")
echo "AGENT_RESULT=$result"
`;

    const result = await engine.execute(script);

    console.log("-- spawn_agent multiline --\n" + result.output + "-- end --");

    expect(result.output).toContain("AGENT_RESULT=Analysed:");
    expect(result.output).toContain("agent=analyst");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("task");
  });
});
